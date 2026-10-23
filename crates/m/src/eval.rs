//! Core evaluator: scopes, expressions, operators, function application.
use crate::ast::*;
use crate::backend::Backend;
use crate::stdlib;
use crate::value::*;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

pub struct Ev<'a> {
    pub be: &'a dyn Backend,
    pub ctr: Cell<u32>,
    pub global: Rc<Scope>,
}

impl<'a> Ev<'a> {
    pub fn new(be: &'a dyn Backend, queries: &BTreeMap<String, String>) -> Ev<'a> {
        let global = Scope::new(None);
        for (name, text) in queries {
            global.vars.borrow_mut().insert(name.clone(), Slot::LazyText(Rc::new(text.clone())));
        }
        Ev { be, ctr: Cell::new(0), global }
    }

    pub fn fresh(&self) -> String {
        let n = self.ctr.get() + 1;
        self.ctr.set(n);
        format!("s{n}")
    }

    /// The `let` scope of a query without evaluating any step (steps are evaluated one by one through `lookup`).
    pub fn open_let(&self, query: &str) -> MResult<Option<(Rc<Scope>, Vec<String>)>> {
        let text = match self.global.vars.borrow().get(query) {
            Some(Slot::LazyText(t)) => t.clone(),
            Some(_) => return Ok(None),
            None => return Err(MError::expr(format!("The query \"{query}\" does not exist."))),
        };
        let parsed = crate::parse(&text).map_err(|e| MError::expr(format!("Syntax error: {e}")))?;
        match parsed {
            Expr::Let { bindings, .. } => {
                let scope = Scope::new(Some(self.global.clone()));
                let names = bindings.iter().map(|b| b.name.clone()).collect();
                for b in bindings {
                    scope.vars.borrow_mut().insert(b.name.clone(), Slot::Lazy(Rc::new(b.expr)));
                }
                Ok(Some((scope, names)))
            }
            _ => Ok(None),
        }
    }

    pub fn lookup(&self, scope: &Rc<Scope>, name: &str) -> MResult<Option<Value>> {
        let mut cur = Some(scope.clone());
        while let Some(s) = cur {
            let slot = s.vars.borrow().get(name).cloned();
            match slot {
                Some(Slot::Done(v)) => return Ok(Some(v)),
                Some(Slot::Failed(e)) => return Err(e),
                Some(Slot::Busy) => return Err(MError::expr(format!("The name \"{name}\" refers to itself (a cycle)."))),
                Some(Slot::Lazy(e)) => {
                    s.vars.borrow_mut().insert(name.to_string(), Slot::Busy);
                    return match self.eval(&e, &s) {
                        Ok(v) => {
                            s.vars.borrow_mut().insert(name.to_string(), Slot::Done(v.clone()));
                            Ok(Some(v))
                        }
                        Err(er) => {
                            s.vars.borrow_mut().insert(name.to_string(), Slot::Failed(er.clone()));
                            Err(er)
                        }
                    };
                }
                Some(Slot::LazyText(t)) => {
                    s.vars.borrow_mut().insert(name.to_string(), Slot::Busy);
                    let r = crate::parse(&t)
                        .map_err(|e| MError::expr(format!("Syntax error in query \"{name}\": {e}")))
                        .and_then(|e| self.eval(&e, &s));
                    return match r {
                        Ok(v) => {
                            s.vars.borrow_mut().insert(name.to_string(), Slot::Done(v.clone()));
                            Ok(Some(v))
                        }
                        Err(er) => {
                            s.vars.borrow_mut().insert(name.to_string(), Slot::Failed(er.clone()));
                            Err(er)
                        }
                    };
                }
                None => cur = s.parent.clone(),
            }
        }
        Ok(None)
    }

    pub fn eval(&self, e: &Expr, scope: &Rc<Scope>) -> MResult<Value> {
        match e {
            Expr::Null => Ok(Value::Null),
            Expr::Bool(b) => Ok(Value::Bool(*b)),
            Expr::Number(n, _) => Ok(Value::Num(*n)),
            Expr::Text(t) => Ok(Value::Text(t.clone())),
            Expr::Ident(name) => {
                if let Some(v) = self.lookup(scope, name)? {
                    return Ok(v);
                }
                if let Some(v) = stdlib::constant(name) {
                    return Ok(v);
                }
                if stdlib::is_builtin(name) {
                    return Ok(Value::Builtin(name.clone()));
                }
                Err(MError::expr(format!("The name '{name}' wasn't recognized. Make sure it's spelled correctly.")))
            }
            Expr::Underscore => self
                .lookup(scope, "_")?
                .ok_or_else(|| MError::expr("The name '_' wasn't recognized. It can only be used inside \"each\".")),
            Expr::ImplicitField(name, opt) => {
                let row = self.eval(&Expr::Underscore, scope)?;
                self.field_of(&row, name, *opt)
            }
            Expr::Record(fields) => {
                let child = Scope::new(Some(scope.clone()));
                let mut out = Vec::new();
                for (n, fe) in fields {
                    let v = self.eval(fe, &child)?;
                    child.set(n, v.clone());
                    out.push((n.clone(), v));
                }
                Ok(Value::Record(out))
            }
            Expr::List(items) => {
                let mut out = Vec::new();
                for i in items {
                    if matches!(i, Expr::Binary(BinOp::Meta, ..)) {
                        return Err(MError::unsupported("List ranges like {1..5} are not supported; use List.Numbers."));
                    }
                    out.push(self.eval(i, scope)?);
                }
                Ok(Value::List(out))
            }
            Expr::Let { bindings, body, .. } => {
                let child = Scope::new(Some(scope.clone()));
                for b in bindings {
                    child.vars.borrow_mut().insert(b.name.clone(), Slot::Lazy(Rc::new(b.expr.clone())));
                }
                self.eval(body, &child)
            }
            Expr::If(c, t, f) => {
                let cv = self.eval(c, scope)?;
                match cv {
                    Value::Bool(true) => self.eval(t, scope),
                    Value::Bool(false) => self.eval(f, scope),
                    v if v.is_symbolic() => {
                        let cs = self.to_sql(&v)?;
                        let a = self.eval(t, scope)?;
                        let b = self.eval(f, scope)?;
                        Ok(Value::Sql(format!("(CASE WHEN {cs} THEN {} ELSE {} END)", self.to_sql(&a)?, self.to_sql(&b)?)))
                    }
                    v => Err(MError::expr(format!("We cannot convert the value {} to type Logical.", self.describe_value(&v)))),
                }
            }
            Expr::Each(body) => Ok(Value::Func(Rc::new(Closure {
                params: vec![Param { name: "_".into(), optional: false, ty: None }],
                body: Rc::new((**body).clone()),
                scope: scope.clone(),
            }))),
            Expr::Func { params, body, .. } => {
                Ok(Value::Func(Rc::new(Closure { params: params.clone(), body: Rc::new((**body).clone()), scope: scope.clone() })))
            }
            Expr::Binary(op, l, r) => self.eval_binary(*op, l, r, scope),
            Expr::Unary(op, x) => {
                let v = self.eval(x, scope)?;
                match (op, v) {
                    (UnOp::Not, Value::Bool(b)) => Ok(Value::Bool(!b)),
                    (UnOp::Not, Value::Null) => Ok(Value::Null),
                    (UnOp::Neg, Value::Num(n)) => Ok(Value::Num(-n)),
                    (UnOp::Neg, Value::Null) => Ok(Value::Null),
                    (UnOp::Pos, v @ Value::Num(_)) => Ok(v),
                    (UnOp::Not, v) if v.is_symbolic() => Ok(Value::Sql(format!("(NOT {})", self.to_sql(&v)?))),
                    (UnOp::Neg, v) if v.is_symbolic() => Ok(Value::Sql(format!("(-{})", self.to_sql(&v)?))),
                    (UnOp::Pos, v) if v.is_symbolic() => Ok(v),
                    (_, v) => Err(MError::expr(format!("The operator cannot be applied to {}.", v.type_name()))),
                }
            }
            Expr::Invoke(callee, args) => {
                let f = self.eval(callee, scope)?;
                // List.Sum(Source[Col]) and the like aggregate in SQL instead of reading the whole column
                if let (Value::Builtin(fname), [only]) = (&f, args.as_slice()) {
                    match only {
                        Expr::Field(base, col, false) => {
                            if let Value::Table(rel) = self.eval(base, scope)? {
                                if let Some(v) = self.table_aggregate(fname, &rel, col.as_str())? {
                                    return Ok(v);
                                }
                            }
                        }
                        // List.Count(List.Distinct(Table[Col]))
                        Expr::Invoke(inner, inner_args) if fname == "List.Count" => {
                            if let (Value::Builtin(d), [Expr::Field(base, col, false)]) = (self.eval(inner, scope)?, inner_args.as_slice()) {
                                if d == "List.Distinct" {
                                    if let Value::Table(rel) = self.eval(base, scope)? {
                                        if let Some(v) = self.table_aggregate("List.CountDistinct", &rel, col.as_str())? {
                                            return Ok(v);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let mut vs = Vec::new();
                for a in args {
                    vs.push(self.eval(a, scope)?);
                }
                self.apply(&f, vs)
            }
            Expr::Field(base, name, opt) => {
                let b = self.eval(base, scope)?;
                self.field_of(&b, name, *opt)
            }
            Expr::Project(base, names, opt) => {
                let b = self.eval(base, scope)?;
                match b {
                    Value::Record(fields) => {
                        let mut out = Vec::new();
                        for n in names {
                            match fields.iter().find(|(k, _)| k == n) {
                                Some((k, v)) => out.push((k.clone(), v.clone())),
                                None if *opt => out.push((n.clone(), Value::Null)),
                                None => return Err(MError::expr(format!("The field '{n}' of the record wasn't found."))),
                            }
                        }
                        Ok(Value::Record(out))
                    }
                    v => Err(MError::unsupported(format!("Selecting several fields of {} is not supported.", v.type_name()))),
                }
            }
            Expr::Item(base, idx, opt) => {
                let b = self.eval(base, scope)?;
                let i = self.eval(idx, scope)?;
                self.item_of(b, i, *opt)
            }
            Expr::Type(t) => Ok(Value::Type(t.clone())),
            Expr::Is(x, t) => {
                let v = self.eval(x, scope)?;
                Ok(Value::Bool(stdlib::value_is(&v, t)?))
            }
            Expr::As(x, t) => {
                let v = self.eval(x, scope)?;
                if !v.is_symbolic() && !stdlib::value_is(&v, t)? {
                    return Err(MError::expr(format!("We cannot convert {} to the requested type.", self.describe_value(&v))));
                }
                Ok(v)
            }
            Expr::Try(body, otherwise) => match self.eval(body, scope) {
                Ok(v) => match otherwise {
                    Some(_) => Ok(v),
                    None => Ok(Value::Record(vec![("HasError".into(), Value::Bool(false)), ("Value".into(), v)])),
                },
                Err(e) => match otherwise {
                    Some(o) => self.eval(o, scope),
                    None => Ok(Value::Record(vec![
                        ("HasError".into(), Value::Bool(true)),
                        ("Error".into(), Value::Record(vec![("Reason".into(), Value::Text(e.reason)), ("Message".into(), Value::Text(e.message))])),
                    ])),
                },
            },
            Expr::Error(m) => {
                let v = self.eval(m, scope)?;
                match v {
                    Value::Text(t) => Err(MError { reason: "Expression.Error".into(), message: t }),
                    Value::Record(f) => {
                        let get = |k: &str| f.iter().find(|(n, _)| n == k).and_then(|(_, v)| if let Value::Text(t) = v { Some(t.clone()) } else { None });
                        Err(MError { reason: get("Reason").unwrap_or_else(|| "Expression.Error".into()), message: get("Message").unwrap_or_default() })
                    }
                    _ => Err(MError::expr("An error was raised.")),
                }
            }
        }
    }

    pub fn describe_value(&self, v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Num(n) => format!("{n}"),
            Value::Text(t) => format!("\"{t}\""),
            other => format!("a value of type {}", other.type_name()),
        }
    }

    pub fn to_sql(&self, v: &Value) -> MResult<String> {
        Ok(match v {
            Value::Null => "NULL".into(),
            Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.into(),
            Value::Num(n) => fmt_num(*n),
            Value::Text(t) => ql(t),
            Value::Sql(s) => s.clone(),
            other => return Err(MError::expr(format!("A column expression cannot use {}.", other.type_name()))),
        })
    }

    fn eval_binary(&self, op: BinOp, l: &Expr, r: &Expr, scope: &Rc<Scope>) -> MResult<Value> {
        let lv = self.eval(l, scope)?;
        // short-circuit on concrete logical values
        if op == BinOp::And && matches!(lv, Value::Bool(false)) {
            return Ok(Value::Bool(false));
        }
        if op == BinOp::Or && matches!(lv, Value::Bool(true)) {
            return Ok(Value::Bool(true));
        }
        let rv = self.eval(r, scope)?;
        self.binary(op, lv, rv)
    }

    pub fn binary(&self, op: BinOp, l: Value, r: Value) -> MResult<Value> {
        if op == BinOp::Meta {
            return Ok(l);
        }
        if l.is_symbolic() || r.is_symbolic() {
            let a = self.to_sql(&l)?;
            let b = self.to_sql(&r)?;
            let s = match op {
                BinOp::Add => format!("({a} + {b})"),
                BinOp::Sub => format!("({a} - {b})"),
                BinOp::Mul => format!("({a} * {b})"),
                BinOp::Div => format!("(CAST({a} AS DOUBLE) / {b})"),
                BinOp::Concat => format!("({a} || {b})"),
                BinOp::Eq => format!("({a} IS NOT DISTINCT FROM {b})"),
                BinOp::Ne => format!("({a} IS DISTINCT FROM {b})"),
                BinOp::Lt => format!("({a} < {b})"),
                BinOp::Gt => format!("({a} > {b})"),
                BinOp::Le => format!("({a} <= {b})"),
                BinOp::Ge => format!("({a} >= {b})"),
                BinOp::And => format!("({a} AND {b})"),
                BinOp::Or => format!("({a} OR {b})"),
                BinOp::Meta => unreachable!(),
            };
            return Ok(Value::Sql(s));
        }
        use Value::*;
        match op {
            BinOp::Eq => Ok(Bool(stdlib::values_equal(&l, &r))),
            BinOp::Ne => Ok(Bool(!stdlib::values_equal(&l, &r))),
            BinOp::And | BinOp::Or => match (&l, &r) {
                (Bool(a), Bool(b)) => Ok(Bool(if op == BinOp::And { *a && *b } else { *a || *b })),
                (Null, Bool(b)) | (Bool(b), Null) => Ok(if op == BinOp::And {
                    if *b { Null } else { Bool(false) }
                } else if *b {
                    Bool(true)
                } else {
                    Null
                }),
                (Null, Null) => Ok(Null),
                _ => Err(MError::expr("The operator requires logical values.")),
            },
            BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div => match (&l, &r) {
                (Null, _) | (_, Null) => Ok(Null),
                (Num(a), Num(b)) => Ok(Num(match op {
                    BinOp::Add => a + b,
                    BinOp::Sub => a - b,
                    BinOp::Mul => a * b,
                    _ => a / b,
                })),
                (List(a), List(b)) if op == BinOp::Add => Ok(List(a.iter().chain(b).cloned().collect())),
                _ => Err(MError::expr(format!("The operator cannot be applied to {} and {}.", l.type_name(), r.type_name()))),
            },
            BinOp::Concat => match (&l, &r) {
                (Null, _) | (_, Null) => Ok(Null),
                (Text(a), Text(b)) => Ok(Text(format!("{a}{b}"))),
                (List(a), List(b)) => Ok(List(a.iter().chain(b).cloned().collect())),
                (Record(a), Record(b)) => {
                    let mut out = a.clone();
                    for (k, v) in b {
                        if let Some(slot) = out.iter_mut().find(|(n, _)| n == k) {
                            slot.1 = v.clone();
                        } else {
                            out.push((k.clone(), v.clone()));
                        }
                    }
                    Ok(Record(out))
                }
                _ => Err(MError::expr(format!("The operator & cannot be applied to {} and {}.", l.type_name(), r.type_name()))),
            },
            BinOp::Lt | BinOp::Gt | BinOp::Le | BinOp::Ge => {
                use std::cmp::Ordering;
                let ord = match (&l, &r) {
                    (Null, _) | (_, Null) => return Ok(Null),
                    (Num(a), Num(b)) => a.partial_cmp(b),
                    (Text(a), Text(b)) => Some(a.cmp(b)),
                    (Bool(a), Bool(b)) => Some(a.cmp(b)),
                    _ => return Err(MError::expr(format!("Values of type {} and {} cannot be compared.", l.type_name(), r.type_name()))),
                };
                let Some(o) = ord else { return Ok(Bool(false)) };
                Ok(Bool(match op {
                    BinOp::Lt => o == Ordering::Less,
                    BinOp::Gt => o == Ordering::Greater,
                    BinOp::Le => o != Ordering::Greater,
                    _ => o != Ordering::Less,
                }))
            }
            BinOp::Meta => unreachable!(),
        }
    }

    pub fn field_of(&self, base: &Value, name: &str, opt: bool) -> MResult<Value> {
        match base {
            Value::Record(fields) => match fields.iter().find(|(k, _)| k == name) {
                Some((_, v)) => Ok(v.clone()),
                None if opt => Ok(Value::Null),
                None => Err(MError::expr(format!("The field '{name}' of the record wasn't found."))),
            },
            Value::Row(ctx) => {
                if !ctx.cols.iter().any(|c| c == name) {
                    if opt {
                        return Ok(Value::Null);
                    }
                    return Err(MError::expr(format!("The field '{name}' of the record wasn't found.")));
                }
                if ctx.group {
                    Ok(Value::ColList { sql: qi(name), distinct: false })
                } else {
                    Ok(Value::Sql(qi(name)))
                }
            }
            Value::Table(rel) => {
                if rel.col(name).is_none() {
                    if opt {
                        return Ok(Value::Null);
                    }
                    return Err(MError::expr(format!("The column '{name}' of the table wasn't found.")));
                }
                self.column_list(rel, name)
            }
            Value::Null if opt => Ok(Value::Null),
            other => Err(MError::expr(format!("Cannot select the field '{name}' of {}.", other.type_name()))),
        }
    }

    fn item_of(&self, base: Value, idx: Value, opt: bool) -> MResult<Value> {
        match base {
            Value::List(items) => match idx {
                Value::Num(n) if n >= 0.0 && (n as usize) < items.len() => Ok(items[n as usize].clone()),
                Value::Num(_) if opt => Ok(Value::Null),
                Value::Num(_) => Err(MError::expr("There weren't enough elements in the enumeration to complete the operation.")),
                _ => Err(MError::expr("A list item index must be a number.")),
            },
            Value::Nav(nav) => self.nav_item(&nav, &idx),
            Value::Table(rel) => match idx {
                Value::Num(n) if n >= 0.0 => self.table_row(&rel, n as usize, opt),
                _ => Err(MError::unsupported("Only a row number is supported to select a row of a table.")),
            },
            Value::Null if opt => Ok(Value::Null),
            other => Err(MError::expr(format!("Cannot select an item of {}.", other.type_name()))),
        }
    }

    pub fn apply(&self, f: &Value, args: Vec<Value>) -> MResult<Value> {
        match f {
            Value::Func(c) => {
                if args.len() > c.params.len() {
                    return Err(MError::expr("There are too many arguments to the function."));
                }
                let child = Scope::new(Some(c.scope.clone()));
                for (i, p) in c.params.iter().enumerate() {
                    match args.get(i) {
                        Some(v) => child.set(&p.name, v.clone()),
                        None if p.optional => child.set(&p.name, Value::Null),
                        None => return Err(MError::expr("There are not enough arguments to the function.")),
                    }
                }
                self.eval(&c.body, &child)
            }
            Value::Builtin(name) => stdlib::call(self, name, args),
            Value::Native(name, _) => Err(MError::unsupported(format!("{name}(...) cannot be called directly here."))),
            other => Err(MError::expr(format!("Cannot call {} as a function.", other.type_name()))),
        }
    }
}
