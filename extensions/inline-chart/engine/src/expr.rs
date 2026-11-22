//! Fast zero-dependency mathematical expression parser and evaluator.
//! Supports +, -, *, /, ^, **, parentheses, unary +/-, built-in constants (pi, e, tau),
//! common math functions (sin, cos, tan, exp, ln, log, log10, log2, sqrt, abs, pow, min, max, etc.),
//! and arbitrary variables (x, t, and control parameter ids).

use std::collections::HashMap;

#[derive(Debug, Clone)]
enum Token {
    Num(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LParen,
    RParen,
    Comma,
}

#[derive(Debug, Clone)]
pub enum Expr {
    Num(f64),
    Var(String),
    Neg(Box<Expr>),
    BinOp {
        op: BinOp,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
    Call {
        name: String,
        args: Vec<Expr>,
    },
}

#[derive(Debug, Clone, Copy)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() || c == '.' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                i += 1;
                if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                    i += 1;
                }
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            let s: String = chars[start..i].iter().collect();
            let v: f64 = s.parse().map_err(|_| format!("invalid number: {s}"))?;
            tokens.push(Token::Num(v));
            continue;
        }
        if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect();
            tokens.push(Token::Ident(ident));
            continue;
        }
        match c {
            '+' => {
                tokens.push(Token::Plus);
                i += 1;
            }
            '-' => {
                tokens.push(Token::Minus);
                i += 1;
            }
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    tokens.push(Token::Caret);
                    i += 2;
                } else {
                    tokens.push(Token::Star);
                    i += 1;
                }
            }
            '/' => {
                tokens.push(Token::Slash);
                i += 1;
            }
            '^' => {
                tokens.push(Token::Caret);
                i += 1;
            }
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma);
                i += 1;
            }
            _ => return Err(format!("unexpected character '{c}'")),
        }
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        if self.pos < self.tokens.len() {
            let t = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(t)
        } else {
            None
        }
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_mul()?;
        loop {
            match self.peek() {
                Some(Token::Plus) => {
                    self.next();
                    let rhs = self.parse_mul()?;
                    lhs = Expr::BinOp {
                        op: BinOp::Add,
                        lhs: Box::new(lhs),
                        rhs: Box::new(rhs),
                    };
                }
                Some(Token::Minus) => {
                    self.next();
                    let rhs = self.parse_mul()?;
                    lhs = Expr::BinOp {
                        op: BinOp::Sub,
                        lhs: Box::new(lhs),
                        rhs: Box::new(rhs),
                    };
                }
                _ => break,
            }
        }
        Ok(lhs)
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_pow()?;
        loop {
            match self.peek() {
                Some(Token::Star) => {
                    self.next();
                    let rhs = self.parse_pow()?;
                    lhs = Expr::BinOp {
                        op: BinOp::Mul,
                        lhs: Box::new(lhs),
                        rhs: Box::new(rhs),
                    };
                }
                Some(Token::Slash) => {
                    self.next();
                    let rhs = self.parse_pow()?;
                    lhs = Expr::BinOp {
                        op: BinOp::Div,
                        lhs: Box::new(lhs),
                        rhs: Box::new(rhs),
                    };
                }
                _ => break,
            }
        }
        Ok(lhs)
    }

    fn parse_pow(&mut self) -> Result<Expr, String> {
        let lhs = self.parse_unary()?;
        if matches!(self.peek(), Some(Token::Caret)) {
            self.next();
            let rhs = self.parse_pow()?;
            return Ok(Expr::BinOp {
                op: BinOp::Pow,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            });
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Some(Token::Plus) => {
                self.next();
                self.parse_unary()
            }
            Some(Token::Minus) => {
                self.next();
                Ok(Expr::Neg(Box::new(self.parse_unary()?)))
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Some(Token::Num(v)) => Ok(Expr::Num(v)),
            Some(Token::Ident(name)) => {
                if matches!(self.peek(), Some(Token::LParen)) {
                    self.next();
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Some(Token::RParen)) {
                        loop {
                            args.push(self.parse_add()?);
                            if matches!(self.peek(), Some(Token::Comma)) {
                                self.next();
                            } else {
                                break;
                            }
                        }
                    }
                    if !matches!(self.next(), Some(Token::RParen)) {
                        return Err(format!("missing ')' in call to {name}"));
                    }
                    Ok(Expr::Call {
                        name: name.to_lowercase(),
                        args,
                    })
                } else {
                    Ok(Expr::Var(name))
                }
            }
            Some(Token::LParen) => {
                let inner = self.parse_add()?;
                if !matches!(self.next(), Some(Token::RParen)) {
                    return Err("missing closing ')'".to_string());
                }
                Ok(inner)
            }
            other => Err(format!("unexpected token: {other:?}")),
        }
    }
}

pub fn parse_expr(input: &str) -> Result<Expr, String> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err("empty formula".to_string());
    }
    let mut parser = Parser { tokens, pos: 0 };
    let expr = parser.parse_add()?;
    if parser.pos < parser.tokens.len() {
        return Err(format!("trailing tokens in formula: {input}"));
    }
    Ok(expr)
}

impl Expr {
    pub fn eval(&self, vars: &HashMap<String, f64>) -> f64 {
        match self {
            Expr::Num(v) => *v,
            Expr::Var(name) => {
                if let Some(&v) = vars.get(name) {
                    return v;
                }
                match name.to_lowercase().as_str() {
                    "pi" => std::f64::consts::PI,
                    "e" => std::f64::consts::E,
                    "tau" => std::f64::consts::TAU,
                    _ => f64::NAN,
                }
            }
            Expr::Neg(e) => -e.eval(vars),
            Expr::BinOp { op, lhs, rhs } => {
                let a = lhs.eval(vars);
                let b = rhs.eval(vars);
                match op {
                    BinOp::Add => a + b,
                    BinOp::Sub => a - b,
                    BinOp::Mul => a * b,
                    BinOp::Div => a / b,
                    BinOp::Pow => a.powf(b),
                }
            }
            Expr::Call { name, args } => {
                let a0 = args.first().map(|e| e.eval(vars)).unwrap_or(f64::NAN);
                let a1 = args.get(1).map(|e| e.eval(vars)).unwrap_or(f64::NAN);
                let a2 = args.get(2).map(|e| e.eval(vars)).unwrap_or(f64::NAN);
                match name.as_str() {
                    "sin" => a0.sin(),
                    "cos" => a0.cos(),
                    "tan" => a0.tan(),
                    "asin" => a0.asin(),
                    "acos" => a0.acos(),
                    "atan" => a0.atan(),
                    "atan2" => a0.atan2(a1),
                    "sinh" => a0.sinh(),
                    "cosh" => a0.cosh(),
                    "tanh" => a0.tanh(),
                    "exp" => a0.exp(),
                    "ln" | "log" => a0.ln(),
                    "log10" => a0.log10(),
                    "log2" => a0.log2(),
                    "sqrt" => a0.sqrt(),
                    "abs" => a0.abs(),
                    "floor" => a0.floor(),
                    "ceil" => a0.ceil(),
                    "round" => a0.round(),
                    "sign" => {
                        if a0 > 0.0 {
                            1.0
                        } else if a0 < 0.0 {
                            -1.0
                        } else {
                            0.0
                        }
                    }
                    "pow" => a0.powf(a1),
                    "min" => a0.min(a1),
                    "max" => a0.max(a1),
                    "clamp" => a0.max(a1).min(a2),
                    _ => f64::NAN,
                }
            }
        }
    }
}
