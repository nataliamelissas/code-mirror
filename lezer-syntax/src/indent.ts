import {NodeProp, Subtree, Tree} from "lezer-tree"
import {EditorState, StateExtension} from "../../state/src/"

export const indentNodeProp = new NodeProp<IndentStrategy>()

export const syntaxIndentation = StateExtension.unique<null>(() => StateExtension.indentation(indentationBehavior))(null)

function indentationBehavior(state: EditorState, pos: number) {
  for (let syntax of state.behavior.get(StateExtension.syntax)) {
    let tree = syntax.tryGetTree(state, pos, pos)
    if (tree) {
      let result = computeIndentation(state, tree, pos)
      if (result > -1) return result
    }
  }
  return -1
}

function computeIndentation(state: EditorState, ast: Tree, pos: number) {
  let tree: Subtree | null = ast.resolve(pos)
  let inner = new IndentContextInner(pos, state)
    
  // Enter previous nodes that end in empty error terms, which means
  // they were broken off by error recovery, so that indentation
  // works even if the constructs haven't been finished.
  for (let scan = tree!, scanPos = pos;;) {
    let last = scan.childBefore(scanPos)
    if (!last) break
    if (last.type.prop(NodeProp.error) && last.start == last.end) {
      tree = scan
      scanPos = last.start
    } else {
      scan = last
      scanPos = scan.end + 1
    }
  }

  for (; tree; tree = tree.parent) {
    let strategy = tree.type.prop(indentNodeProp) || (tree.parent == null ? topIndent : null)
    if (strategy) {
      let indentContext = new IndentContext(inner, tree, strategy, null)
      return indentContext.getIndent()
    }
  }
  return -1
}

class IndentContextInner {
  unit: number

  constructor(readonly pos: number,
              readonly state: EditorState) {
    this.unit = state.indentUnit
  }
}

export class IndentContext {
  private _next: IndentContext | null = null

  constructor(private inner: IndentContextInner,
              readonly tree: Subtree,
              readonly strategy: IndentStrategy,
              readonly prev: IndentContext | null) {}

  get state() { return this.inner.state }
  get pos() { return this.inner.pos }
  get unit() { return this.inner.unit }

  get next() {
    if (this._next) return this._next
    let last = this.tree, found = null
    for (let tree = this.tree.parent; !found && tree; tree = tree.parent) {
      found = tree.type.prop(indentNodeProp)
      last = tree
    }
    return this._next = new IndentContext(this.inner, last, found || topIndent, this)
  }

  get textAfter() {
    return this.state.doc.slice(this.pos, Math.min(this.pos + 50, this.state.doc.lineAt(this.pos).end)).match(/^\s*(.*)/)![1]
  }

  getIndent() { return this.strategy.getIndent(this) }

  baseIndent() {
    let f = this.strategy.baseIndent
    return f ? f(this) : -1
  }

  get startLine() {
    return this.state.doc.lineAt(this.tree.start)
  }

  get textBefore() {
    let line = this.startLine
    return line.slice(0, this.tree.start - line.start)
  }

  countColumn(line: string, pos: number) {
    if (pos < 0) pos = line.length
    let tab = this.state.tabSize
    for (var i = 0, n = 0;;) {
      let nextTab = line.indexOf("\t", i);
      if (nextTab < 0 || nextTab >= pos) return n + (pos - i)
      n += nextTab - i
      n += tab - (n % tab)
      i = nextTab + 1
    }
  }

  get lineIndent() {
    let line = this.textBefore
    return this.countColumn(line, line.search(/\S/))
  }

  column(pos: number) {
    let line = this.state.doc.lineAt(pos)
    return this.countColumn(line.slice(0, pos - line.start), pos - line.start)
  }
}

export interface IndentStrategy {
  getIndent: (context: IndentContext) => number
  baseIndent?: (context: IndentContext) => number
}

export const topIndent: IndentStrategy = {
  getIndent() { return 0 },
  baseIndent() { return 0 }
}

function bracketedAligned(context: IndentContext) {
  let tree = context.tree
  let openToken = tree.childAfter(tree.start)
  if (!openToken) return null
  let openLine = context.state.doc.lineAt(openToken.start)
  for (let pos = openToken.end;;) {
    let next = tree.childAfter(pos)
    if (!next) return null
    if (!next.type.prop(NodeProp.skipped))
      return next.start < openLine.end ? openToken : null
    pos = next.end
  }
}

export function delimitedIndent({closing, align = true}: {closing: string, align?: boolean}): IndentStrategy {
  return {
    getIndent(context: IndentContext) {
      let closed = context.textAfter.slice(0, closing.length) == closing
      let aligned = align ? bracketedAligned(context) : null
      if (aligned) return closed ? context.column(aligned.start) : context.column(aligned.end)
      return context.next.baseIndent() + (closed ? 0 : context.unit)
    },
    baseIndent(context: IndentContext) {
      let newLine = context.startLine.start != context.prev!.startLine.start
      let aligned = align && newLine ? bracketedAligned(context) : null
      if (aligned) return context.column(aligned.end)
      return context.next.baseIndent() + (newLine ? context.unit : 0)
    }
  }
}

// FIXME automatically create a delimitedIndent for nodes with delim prop?

export const parenIndent = delimitedIndent({closing: ")"}),
  braceIndent = delimitedIndent({closing: "}"}),
  bracketIndent = delimitedIndent({closing: "]"})

export const statementIndent: IndentStrategy = {
  getIndent(context: IndentContext) {
    return context.baseIndent() + context.unit
  },
  baseIndent(context: IndentContext) {
    return context.lineIndent
  }
}

export function compositeStatementIndent(dedentBefore: RegExp): IndentStrategy {
  return {
    getIndent(context: IndentContext) {
      return context.baseIndent() + (dedentBefore.test(context.textAfter) ? 0 : context.unit)
    },
    baseIndent(context: IndentContext) {
      return context.lineIndent
    }
  }
}

export const dontIndent: IndentStrategy = {
  getIndent() { return -1 }
}