// Level curves: how much XP each level takes. Shared by the bot
// (leveling/config.js) and the dashboard page, which draws the curve, so both
// work the level out the same way.
//
// A curve is a formula for the XP a member needs to go from the level they are
// on to the next one. It uses one variable, `level`: 0 for a new member, 1 once
// they reach level 1, and so on. The standard curve is
// 5 * level^2 + 50 * level + 100, so level 0 -> 1 takes 100 XP, 1 -> 2 takes
// 155, 2 -> 3 takes 220. The total to reach level N is the sum of the steps
// for levels 0 to N - 1.
//
// Formulas are read by a small parser below, never run as code. It knows
// numbers, `level`, + - * / % ^ (power), brackets and the functions in
// FUNCTIONS. Every step is rounded to a whole number and must come out between
// MIN_STEP_XP and MAX_STEP_XP at every level up to MAX_CURVE_LEVEL.

export const MAX_CURVE_LEVEL = 500; // the same as MAX_LEVEL in leveling/config.js
export const MAX_FORMULA_LENGTH = 200;
export const MIN_STEP_XP = 1;
export const MAX_STEP_XP = 10_000_000;
const MAX_TOKENS = 120;
const MAX_DEPTH = 24;

export const STANDARD_FORMULA = "5 * level^2 + 50 * level + 100";

// Ready-made curves for the page's simple picker.
export const CURVE_PRESETS = Object.freeze([
  { id: "standard", formula: STANDARD_FORMULA },
  { id: "flat", formula: "300" },
  { id: "linear", formula: "100 + 40 * level" },
  { id: "gentle", formula: "3 * level^2 + 30 * level + 100" },
  { id: "steep", formula: "10 * level^2 + 100 * level + 200" },
  { id: "exponential", formula: "min(100 * 1.06^level, 100000)" },
]);

// name -> [fewest arguments, most arguments, function]
const FUNCTIONS = Object.freeze({
  __proto__: null,
  min: [1, 8, Math.min],
  max: [1, 8, Math.max],
  floor: [1, 1, Math.floor],
  ceil: [1, 1, Math.ceil],
  round: [1, 1, Math.round],
  abs: [1, 1, Math.abs],
  sqrt: [1, 1, Math.sqrt],
  ln: [1, 1, Math.log],
  log10: [1, 1, Math.log10],
});
export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS);

export class InvalidFormula extends Error {
  name = "InvalidFormula";
}

// "5 * level^2" -> [{ type: "number", value: 5 }, { type: "op", value: "*" }, …]
function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(text.slice(index));
    if (number) {
      tokens.push({ type: "number", value: Number(number[0]), at: index });
      index += number[0].length;
      continue;
    }
    const word = /^[a-z][a-z0-9]*/i.exec(text.slice(index));
    if (word) {
      tokens.push({ type: "word", value: word[0].toLowerCase(), at: index });
      index += word[0].length;
      continue;
    }
    if ("+-*/%^(),".includes(char)) {
      tokens.push({ type: char === "(" || char === ")" || char === "," ? char : "op", value: char, at: index });
      index += 1;
      continue;
    }
    throw new InvalidFormula(`"${char}" can't be used in a formula. Use numbers, level, + - * / % ^ and brackets.`);
  }
  if (tokens.length > MAX_TOKENS) {
    throw new InvalidFormula("That formula is too long. Keep it shorter.");
  }
  return tokens;
}

// Recursive descent, lowest precedence first:
//   sum     = product (("+" | "-") product)*
//   product = unary (("*" | "/" | "%") unary)*
//   unary   = "-" unary | "+" unary | power
//   power   = atom ("^" unary)?          (right to left: 2^3^2 = 2^9)
//   atom    = number | "level" | name "(" sum ("," sum)* ")" | "(" sum ")"
// The result is a tree: { number }, { variable }, { op, left, right },
// { negate }, { call, args }.
function parse(text) {
  const tokens = tokenize(text);
  let position = 0;
  let depth = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const deeper = (read) => {
    depth += 1;
    if (depth > MAX_DEPTH) {
      throw new InvalidFormula("That formula has too many brackets inside each other.");
    }
    const node = read();
    depth -= 1;
    return node;
  };
  const expect = (type, message) => {
    const token = next();
    if (!token || token.type !== type) {
      throw new InvalidFormula(message);
    }
    return token;
  };

  function sum() {
    let node = product();
    while (peek()?.type === "op" && (peek().value === "+" || peek().value === "-")) {
      node = { op: next().value, left: node, right: product() };
    }
    return node;
  }
  function product() {
    let node = unary();
    while (peek()?.type === "op" && "*/%".includes(peek().value)) {
      node = { op: next().value, left: node, right: unary() };
    }
    return node;
  }
  function unary() {
    if (peek()?.type === "op" && (peek().value === "-" || peek().value === "+")) {
      const sign = next().value;
      return deeper(() => {
        const node = unary();
        return sign === "-" ? { negate: node } : node;
      });
    }
    return power();
  }
  function power() {
    const base = atom();
    if (peek()?.type === "op" && peek().value === "^") {
      next();
      return { op: "^", left: base, right: deeper(unary) };
    }
    return base;
  }
  function atom() {
    const token = next();
    if (!token) {
      throw new InvalidFormula("The formula ends too early. Is a number or bracket missing?");
    }
    if (token.type === "number") {
      return { number: token.value };
    }
    if (token.type === "(") {
      const node = deeper(sum);
      expect(")", "A bracket is opened but never closed.");
      return node;
    }
    if (token.type === "word") {
      if (token.value === "level") {
        return { variable: "level" };
      }
      // Own keys only, so names like "constructor" aren't found on the prototype.
      const known = Object.hasOwn(FUNCTIONS, token.value) ? FUNCTIONS[token.value] : undefined;
      if (!known) {
        throw new InvalidFormula(`"${token.value}" isn't known. Use level, or one of: ${FORMULA_FUNCTIONS.join(", ")}.`);
      }
      expect("(", `Put brackets after ${token.value}, like ${token.value}(level).`);
      const args = [deeper(sum)];
      while (peek()?.type === ",") {
        next();
        args.push(deeper(sum));
      }
      expect(")", `Close the bracket after ${token.value}(…).`);
      const [fewest, most] = known;
      if (args.length < fewest || args.length > most) {
        throw new InvalidFormula(
          fewest === most ? `${token.value}() takes ${fewest} value.` : `${token.value}() takes ${fewest} to ${most} values.`,
        );
      }
      return { call: token.value, args };
    }
    throw new InvalidFormula(`"${token.value}" is in the wrong place.`);
  }

  if (tokens.length === 0) {
    throw new InvalidFormula("Write a formula, like " + STANDARD_FORMULA + ".");
  }
  const tree = sum();
  if (position < tokens.length) {
    throw new InvalidFormula(`"${tokens[position].value}" is in the wrong place.`);
  }
  return tree;
}

function evaluate(node, level) {
  if ("number" in node) {
    return node.number;
  }
  if ("variable" in node) {
    return level;
  }
  if ("negate" in node) {
    return -evaluate(node.negate, level);
  }
  if ("call" in node) {
    return FUNCTIONS[node.call][2](...node.args.map((arg) => evaluate(arg, level)));
  }
  const left = evaluate(node.left, level);
  const right = evaluate(node.right, level);
  switch (node.op) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    default:
      return left ** right;
  }
}

// The curve for a formula: steps[level] = XP from `level` to `level + 1`, and
// totals[level] = XP to reach `level` from zero (totals[0] = 0). Throws
// InvalidFormula, naming the first level that goes wrong.
export function buildCurve(formula) {
  if (typeof formula !== "string" || formula.trim() === "") {
    throw new InvalidFormula("Write a formula, like " + STANDARD_FORMULA + ".");
  }
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw new InvalidFormula(`Keep the formula under ${MAX_FORMULA_LENGTH} characters.`);
  }
  const tree = parse(formula);
  const steps = [];
  const totals = [0];
  for (let level = 0; level < MAX_CURVE_LEVEL; level += 1) {
    const value = evaluate(tree, level);
    if (!Number.isFinite(value)) {
      throw new InvalidFormula(`At level ${level} the formula doesn't give a number (dividing by zero, or a root of a negative?).`);
    }
    const step = Math.round(value);
    if (step < MIN_STEP_XP) {
      throw new InvalidFormula(`At level ${level} the formula gives ${step} XP. Every level must take at least ${MIN_STEP_XP} XP.`);
    }
    if (step > MAX_STEP_XP) {
      throw new InvalidFormula(
        `At level ${level} the formula gives more than ${MAX_STEP_XP.toLocaleString("en")} XP for one level. Wrap it in min(…, ${MAX_STEP_XP}) or make it smaller.`,
      );
    }
    steps.push(step);
    totals.push(totals[level] + step);
  }
  return { formula: formula.trim(), steps, totals };
}

// The same, or null when the formula is bad.
export function tryBuildCurve(formula) {
  try {
    return buildCurve(formula);
  } catch (error) {
    if (error instanceof InvalidFormula) {
      return null;
    }
    throw error;
  }
}

// { level, current, needed } for this much XP on a curve: the level, the XP
// gained within it and the XP the next level takes. At the top level, needed is
// what the next step would be, so progress bars still fill.
export function progressOnCurve(curve, xp) {
  const amount = Math.max(0, Number.isFinite(xp) ? xp : 0);
  // The highest level whose total is at most `amount` (binary search).
  let low = 0;
  let high = MAX_CURVE_LEVEL;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (curve.totals[middle] <= amount) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const needed = curve.steps[Math.min(low, MAX_CURVE_LEVEL - 1)];
  return { level: low, current: amount - curve.totals[low], needed };
}

export const standardCurve = buildCurve(STANDARD_FORMULA);
