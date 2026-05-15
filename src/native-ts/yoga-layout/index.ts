/**
 * yoga-layout（Meta flexbox 引擎）的纯 TypeScript 移植版。
 *
 * 该实现对齐 src/ink/layout/yoga.ts 使用的 `yoga-layout/load` API 形状。
 * 相比上游庞大的 C++ 实现，这里采用简化后的单遍 flexbox 实现，覆盖 Ink
 * 实际依赖的功能子集，并额外补上一部分为了规范一致性而实现、但 Ink
 * 当前并未使用的行为。
 */

import {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from './enums.js'

export {
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
}

// --
// 数值类型

export type Value = {
  unit: Unit
  value: number
}

const UNDEFINED_VALUE: Value = { unit: Unit.Undefined, value: NaN }
const AUTO_VALUE: Value = { unit: Unit.Auto, value: NaN }

function pointValue(v: number): Value {
  return { unit: Unit.Point, value: v }
}
function percentValue(v: number): Value {
  return { unit: Unit.Percent, value: v }
}

function resolveValue(v: Value, ownerSize: number): number {
  switch (v.unit) {
    case Unit.Point:
      return v.value
    case Unit.Percent:
      return isNaN(ownerSize) ? NaN : (v.value * ownerSize) / 100
    default:
      return NaN
  }
}

function isDefined(n: number): boolean {
  return !isNaN(n)
}

// 用于 layout cache 输入比较的 NaN 安全相等判断。
function sameFloat(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b)
}

// --
// 布局结果（计算后的值）

type Layout = {
  left: number
  top: number
  width: number
  height: number
  // 每条边的计算结果（已解析成物理边）。
  border: [number, number, number, number] // left, top, right, bottom
  padding: [number, number, number, number]
  margin: [number, number, number, number]
}

// --
// 样式（输入值）

type Style = {
  direction: Direction
  flexDirection: FlexDirection
  justifyContent: Justify
  alignItems: Align
  alignSelf: Align
  alignContent: Align
  flexWrap: Wrap
  overflow: Overflow
  display: Display
  positionType: PositionType

  flexGrow: number
  flexShrink: number
  flexBasis: Value

  // 以 Edge enum 为索引的 9 边数组。
  margin: Value[]
  padding: Value[]
  border: Value[]
  position: Value[]

  // 以 Gutter enum 为索引的 3 gutter 数组。
  gap: Value[]

  width: Value
  height: Value
  minWidth: Value
  minHeight: Value
  maxWidth: Value
  maxHeight: Value
}

function defaultStyle(): Style {
  return {
    direction: Direction.Inherit,
    flexDirection: FlexDirection.Column,
    justifyContent: Justify.FlexStart,
    alignItems: Align.Stretch,
    alignSelf: Align.Auto,
    alignContent: Align.FlexStart,
    flexWrap: Wrap.NoWrap,
    overflow: Overflow.Visible,
    display: Display.Flex,
    positionType: PositionType.Relative,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: AUTO_VALUE,
    margin: new Array(9).fill(UNDEFINED_VALUE),
    padding: new Array(9).fill(UNDEFINED_VALUE),
    border: new Array(9).fill(UNDEFINED_VALUE),
    position: new Array(9).fill(UNDEFINED_VALUE),
    gap: new Array(3).fill(UNDEFINED_VALUE),
    width: AUTO_VALUE,
    height: AUTO_VALUE,
    minWidth: UNDEFINED_VALUE,
    minHeight: UNDEFINED_VALUE,
    maxWidth: UNDEFINED_VALUE,
    maxHeight: UNDEFINED_VALUE,
  }
}

// --
// 边解析逻辑：把 yoga 的 9 边模型折叠成 4 条物理边

const EDGE_LEFT = 0
const EDGE_TOP = 1
const EDGE_RIGHT = 2
const EDGE_BOTTOM = 3

function resolveEdge(
  edges: Value[],
  physicalEdge: number,
  ownerSize: number,
  // 对 margin/position 允许 auto；padding/border 上的 auto 会解析为 0。
  allowAuto = false,
): number {
  // 优先级：具体边 > horizontal/vertical > all。
  let v = edges[physicalEdge]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT || physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.Horizontal]!
    } else {
      v = edges[Edge.Vertical]!
    }
  }
  if (v.unit === Unit.Undefined) {
    v = edges[Edge.All]!
  }
  // 在 LTR 下，Start/End 映射到 Left/Right（Ink 始终走 LTR）。
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT) v = edges[Edge.Start]!
    if (physicalEdge === EDGE_RIGHT) v = edges[Edge.End]!
  }
  if (v.unit === Unit.Undefined) return 0
  if (v.unit === Unit.Auto) return allowAuto ? NaN : 0
  return resolveValue(v, ownerSize)
}

function resolveEdgeRaw(edges: Value[], physicalEdge: number): Value {
  let v = edges[physicalEdge]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT || physicalEdge === EDGE_RIGHT) {
      v = edges[Edge.Horizontal]!
    } else {
      v = edges[Edge.Vertical]!
    }
  }
  if (v.unit === Unit.Undefined) v = edges[Edge.All]!
  if (v.unit === Unit.Undefined) {
    if (physicalEdge === EDGE_LEFT) v = edges[Edge.Start]!
    if (physicalEdge === EDGE_RIGHT) v = edges[Edge.End]!
  }
  return v
}

function isMarginAuto(edges: Value[], physicalEdge: number): boolean {
  return resolveEdgeRaw(edges, physicalEdge).unit === Unit.Auto
}

// _hasAutoMargin / _hasPosition 快路径标记的 setter 辅助函数。
// 数值上 Unit.Undefined = 0，Unit.Auto = 3。
function hasAnyAutoEdge(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) if (edges[i]!.unit === 3) return true
  return false
}
function hasAnyDefinedEdge(edges: Value[]): boolean {
  for (let i = 0; i < 9; i++) if (edges[i]!.unit !== 0) return true
  return false
}

// 热路径：一次性解析 4 条物理边，并直接写入 `out`。
// 等价于调用 4 次 resolveEdge() 且 allowAuto=false，
// 但这里把共享的 fallback 查找（Horizontal/Vertical/All/Start/End）提出来，
// 同时避免在每次 layoutNode() 调用时新分配一个 4 元数组。
function resolveEdges4Into(
  edges: Value[],
  ownerSize: number,
  out: [number, number, number, number],
): void {
  // 先统一提取 fallback，因为 4 条边的解析链都会共享这些读取。
  const eH = edges[6]! // Edge.Horizontal
  const eV = edges[7]! // Edge.Vertical
  const eA = edges[8]! // Edge.All
  const eS = edges[4]! // Edge.Start
  const eE = edges[5]! // Edge.End
  const pctDenom = isNaN(ownerSize) ? NaN : ownerSize / 100

  // 左边：edges[0] → Horizontal → All → Start
  let v = edges[0]!
  if (v.unit === 0) v = eH
  if (v.unit === 0) v = eA
  if (v.unit === 0) v = eS
  out[0] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 上边：edges[1] → Vertical → All
  v = edges[1]!
  if (v.unit === 0) v = eV
  if (v.unit === 0) v = eA
  out[1] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 右边：edges[2] → Horizontal → All → End
  v = edges[2]!
  if (v.unit === 0) v = eH
  if (v.unit === 0) v = eA
  if (v.unit === 0) v = eE
  out[2] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0

  // 下边：edges[3] → Vertical → All
  v = edges[3]!
  if (v.unit === 0) v = eV
  if (v.unit === 0) v = eA
  out[3] = v.unit === 1 ? v.value : v.unit === 2 ? v.value * pctDenom : 0
}

// --
// 轴辅助函数

function isRow(dir: FlexDirection): boolean {
  return dir === FlexDirection.Row || dir === FlexDirection.RowReverse
}
function isReverse(dir: FlexDirection): boolean {
  return dir === FlexDirection.RowReverse || dir === FlexDirection.ColumnReverse
}
function crossAxis(dir: FlexDirection): FlexDirection {
  return isRow(dir) ? FlexDirection.Column : FlexDirection.Row
}
function leadingEdge(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return EDGE_LEFT
    case FlexDirection.RowReverse:
      return EDGE_RIGHT
    case FlexDirection.Column:
      return EDGE_TOP
    case FlexDirection.ColumnReverse:
      return EDGE_BOTTOM
  }
}
function trailingEdge(dir: FlexDirection): number {
  switch (dir) {
    case FlexDirection.Row:
      return EDGE_RIGHT
    case FlexDirection.RowReverse:
      return EDGE_LEFT
    case FlexDirection.Column:
      return EDGE_BOTTOM
    case FlexDirection.ColumnReverse:
      return EDGE_TOP
  }
}

// --
// 对外类型

export type MeasureFunction = (
  width: number,
  widthMode: MeasureMode,
  height: number,
  heightMode: MeasureMode,
) => { width: number; height: number }

export type Size = { width: number; height: number }

// --
// 配置

export type Config = {
  pointScaleFactor: number
  errata: Errata
  useWebDefaults: boolean
  free(): void
  isExperimentalFeatureEnabled(_: ExperimentalFeature): boolean
  setExperimentalFeatureEnabled(_: ExperimentalFeature, __: boolean): void
  setPointScaleFactor(factor: number): void
  getErrata(): Errata
  setErrata(errata: Errata): void
  setUseWebDefaults(v: boolean): void
}

function createConfig(): Config {
  const config: Config = {
    pointScaleFactor: 1,
    errata: Errata.None,
    useWebDefaults: false,
    free() {},
    isExperimentalFeatureEnabled() {
      return false
    },
    setExperimentalFeatureEnabled() {},
    setPointScaleFactor(f) {
      config.pointScaleFactor = f
    },
    getErrata() {
      return config.errata
    },
    setErrata(e) {
      config.errata = e
    },
    setUseWebDefaults(v) {
      config.useWebDefaults = v
    },
  }
  return config
}

// --
// Node 实现

export class Node {
  style: Style
  layout: Layout
  parent: Node | null
  children: Node[]
  measureFunc: MeasureFunction | null
  config: Config
  isDirty_: boolean
  isReferenceBaseline_: boolean

  // 每次布局过程使用的临时字段（不属于公开 API）。
  _flexBasis = 0
  _mainSize = 0
  _crossSize = 0
  _lineIndex = 0
  // 由 style setter 维护的快路径标记。
  // 从 CPU profile 看，positioning 循环里每个子节点每次布局都会调用
  // 6 次 isMarginAuto 与 4 次 resolveEdgeRaw(position)，
  // 在 1000 节点基准下大约是 11k 次调用，而绝大多数节点既没有 auto margin
  // 也没有 position inset，几乎都会返回 false/undefined。
  // 这些标记能让我们用一个分支直接走到最常见路径。
  _hasAutoMargin = false
  _hasPosition = false
  // 对每次 layoutNode() 开头那 3 次 resolveEdges4Into 调用也采用同样思路。
  // 在 1000 节点基准里，大约 67% 的调用面对的都是全 undefined 边数组
  // （多数节点没有 border，只有列有 padding，只有叶子单元有 margin），
  // 因此一个单分支跳过要优于约 20 次属性读取、15 次比较和 4 次写零。
  _hasPadding = false
  _hasBorder = false
  _hasMargin = false
  // -- 基于 dirty 标记的布局缓存。
  // 思路与上游 CalculateLayout.cpp 中的 layoutNodeInternal 一致：
  // 当子树是干净的，且当前问题与缓存命中的问题一致时，直接整棵子树跳过。
  // 这里用两个槽位，因为节点通常会先经历一次 measure 调用
  // （performLayout=false，来自 computeFlexBasis），再经历一次 layout 调用
  // （performLayout=true），而父节点每轮传入的参数又可能不同；
  // 单槽位会导致频繁抖动。这个优化把重新布局基准
  // （脏一个叶子、重算 root）从 2.7x 降到了 1.1x：
  // 干净兄弟节点直接跳过，只有脏链路会重新计算。
  _lW = NaN
  _lH = NaN
  _lWM: MeasureMode = 0
  _lHM: MeasureMode = 0
  _lOW = NaN
  _lOH = NaN
  _lFW = false
  _lFH = false
  // _hasL 会在较早阶段保存输入（计算前），但 layout.width/height 之后可能会被
  // 多槽缓存或其他不同输入下的计算改写。
  // 如果不额外保存输出，_hasL 命中时读到的就只是“上一次遗留下来的布局尺寸”，
  // 这正是 scrollbox 的 vpH=33→2624 问题来源。
  // 因此这里和多槽缓存一样，显式存储并恢复输出值。
  _lOutW = NaN
  _lOutH = NaN
  _hasL = false
  _mW = NaN
  _mH = NaN
  _mWM: MeasureMode = 0
  _mHM: MeasureMode = 0
  _mOW = NaN
  _mOH = NaN
  _mOutW = NaN
  _mOutH = NaN
  _hasM = false
  // computeFlexBasis 的缓存结果。
  // 对于干净子节点，basis 只依赖容器内部尺寸；如果这些尺寸没变，
  // 就可以完全跳过 layoutNode(performLayout=false) 的递归。
  // 这是滚动场景的热点路径：当 500 条消息的容器是脏的，但其中 499 个子节点是干净的，
  // 它们会随着脏链路的 measure/layout 级联而被重复测量约 20 次。
  // basis cache 可以在子节点边界处直接短路。
  _fbBasis = NaN
  _fbOwnerW = NaN
  _fbOwnerH = NaN
  _fbAvailMain = NaN
  _fbAvailCross = NaN
  _fbCrossMode: MeasureMode = 0
  // _fbBasis 写入时所对应的 generation。
  // 来自旧 generation 的脏节点缓存一定是陈旧的，因为子树已经改变；
  // 但同一 generation 内缓存仍然是新鲜的，脏链路的 measure→layout 级联
  // 会让 fresh mount 节点在一次 calculateLayout 中被重复调用 computeFlexBasis
  // 多次，而这些调用之间子树并不会再变化。
  // 因此按 generation 而非 isDirty_ 作为门控，能让 fresh mount
  // （例如虚拟滚动）在第一次计算后就开始命中缓存：105k 次访问降到约 10k。
  _fbGen = -1
  // 多槽布局缓存：保存“输入 -> 计算得到的 w/h”，这样即使输入不同于 _hasL，
  // 也能恢复正确尺寸。上游 yoga 用 16 个槽位；这里 4 个就足以覆盖 Ink 的脏链深度。
  // 为避免每个条目额外分配对象，内部采用扁平数组存储。
  // 槽位 i 在 _cIn 中占 [i*8, i*8+8)（aW,aH,wM,hM,oW,oH,fW,fH），
  // 在 _cOut 中占 [i*2, i*2+2)（w,h）。
  _cIn: Float64Array | null = null
  _cOut: Float64Array | null = null
  _cGen = -1
  _cN = 0
  _cWr = 0

  constructor(config?: Config) {
    this.style = defaultStyle()
    this.layout = {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      border: [0, 0, 0, 0],
      padding: [0, 0, 0, 0],
      margin: [0, 0, 0, 0],
    }
    this.parent = null
    this.children = []
    this.measureFunc = null
    this.config = config ?? DEFAULT_CONFIG
    this.isDirty_ = true
    this.isReferenceBaseline_ = false
    _yogaLiveNodes++
  }

  // -- Tree

  insertChild(child: Node, index: number): void {
    child.parent = this
    this.children.splice(index, 0, child)
    this.markDirty()
  }
  removeChild(child: Node): void {
    const idx = this.children.indexOf(child)
    if (idx >= 0) {
      this.children.splice(idx, 1)
      child.parent = null
      this.markDirty()
    }
  }
  getChild(index: number): Node {
    return this.children[index]!
  }
  getChildCount(): number {
    return this.children.length
  }
  getParent(): Node | null {
    return this.parent
  }

  // -- Lifecycle

  free(): void {
    this.parent = null
    this.children = []
    this.measureFunc = null
    this._cIn = null
    this._cOut = null
    _yogaLiveNodes--
  }
  freeRecursive(): void {
    for (const c of this.children) c.freeRecursive()
    this.free()
  }
  reset(): void {
    this.style = defaultStyle()
    this.children = []
    this.parent = null
    this.measureFunc = null
    this.isDirty_ = true
    this._hasAutoMargin = false
    this._hasPosition = false
    this._hasPadding = false
    this._hasBorder = false
    this._hasMargin = false
    this._hasL = false
    this._hasM = false
    this._cN = 0
    this._cWr = 0
    this._fbBasis = NaN
  }

  // -- Dirty tracking

  markDirty(): void {
    this.isDirty_ = true
    if (this.parent && !this.parent.isDirty_) this.parent.markDirty()
  }
  isDirty(): boolean {
    return this.isDirty_
  }
  hasNewLayout(): boolean {
    return true
  }
  markLayoutSeen(): void {}

  // -- Measure function

  setMeasureFunc(fn: MeasureFunction | null): void {
    this.measureFunc = fn
    this.markDirty()
  }
  unsetMeasureFunc(): void {
    this.measureFunc = null
    this.markDirty()
  }

  // -- Computed layout getters

  getComputedLeft(): number {
    return this.layout.left
  }
  getComputedTop(): number {
    return this.layout.top
  }
  getComputedWidth(): number {
    return this.layout.width
  }
  getComputedHeight(): number {
    return this.layout.height
  }
  getComputedRight(): number {
    const p = this.parent
    return p ? p.layout.width - this.layout.left - this.layout.width : 0
  }
  getComputedBottom(): number {
    const p = this.parent
    return p ? p.layout.height - this.layout.top - this.layout.height : 0
  }
  getComputedLayout(): {
    left: number
    top: number
    right: number
    bottom: number
    width: number
    height: number
  } {
    return {
      left: this.layout.left,
      top: this.layout.top,
      right: this.getComputedRight(),
      bottom: this.getComputedBottom(),
      width: this.layout.width,
      height: this.layout.height,
    }
  }
  getComputedBorder(edge: Edge): number {
    return this.layout.border[physicalEdge(edge)]!
  }
  getComputedPadding(edge: Edge): number {
    return this.layout.padding[physicalEdge(edge)]!
  }
  getComputedMargin(edge: Edge): number {
    return this.layout.margin[physicalEdge(edge)]!
  }

  // -- Style setters: dimensions

  setWidth(v: number | 'auto' | string | undefined): void {
    this.style.width = parseDimension(v)
    this.markDirty()
  }
  setWidthPercent(v: number): void {
    this.style.width = percentValue(v)
    this.markDirty()
  }
  setWidthAuto(): void {
    this.style.width = AUTO_VALUE
    this.markDirty()
  }
  setHeight(v: number | 'auto' | string | undefined): void {
    this.style.height = parseDimension(v)
    this.markDirty()
  }
  setHeightPercent(v: number): void {
    this.style.height = percentValue(v)
    this.markDirty()
  }
  setHeightAuto(): void {
    this.style.height = AUTO_VALUE
    this.markDirty()
  }
  setMinWidth(v: number | string | undefined): void {
    this.style.minWidth = parseDimension(v)
    this.markDirty()
  }
  setMinWidthPercent(v: number): void {
    this.style.minWidth = percentValue(v)
    this.markDirty()
  }
  setMinHeight(v: number | string | undefined): void {
    this.style.minHeight = parseDimension(v)
    this.markDirty()
  }
  setMinHeightPercent(v: number): void {
    this.style.minHeight = percentValue(v)
    this.markDirty()
  }
  setMaxWidth(v: number | string | undefined): void {
    this.style.maxWidth = parseDimension(v)
    this.markDirty()
  }
  setMaxWidthPercent(v: number): void {
    this.style.maxWidth = percentValue(v)
    this.markDirty()
  }
  setMaxHeight(v: number | string | undefined): void {
    this.style.maxHeight = parseDimension(v)
    this.markDirty()
  }
  setMaxHeightPercent(v: number): void {
    this.style.maxHeight = percentValue(v)
    this.markDirty()
  }

  // -- Style setters: flex

  setFlexDirection(dir: FlexDirection): void {
    this.style.flexDirection = dir
    this.markDirty()
  }
  setFlexGrow(v: number | undefined): void {
    this.style.flexGrow = v ?? 0
    this.markDirty()
  }
  setFlexShrink(v: number | undefined): void {
    this.style.flexShrink = v ?? 0
    this.markDirty()
  }
  setFlex(v: number | undefined): void {
    if (v === undefined || isNaN(v)) {
      this.style.flexGrow = 0
      this.style.flexShrink = 0
    } else if (v > 0) {
      this.style.flexGrow = v
      this.style.flexShrink = 1
      this.style.flexBasis = pointValue(0)
    } else if (v < 0) {
      this.style.flexGrow = 0
      this.style.flexShrink = -v
    } else {
      this.style.flexGrow = 0
      this.style.flexShrink = 0
    }
    this.markDirty()
  }
  setFlexBasis(v: number | 'auto' | string | undefined): void {
    this.style.flexBasis = parseDimension(v)
    this.markDirty()
  }
  setFlexBasisPercent(v: number): void {
    this.style.flexBasis = percentValue(v)
    this.markDirty()
  }
  setFlexBasisAuto(): void {
    this.style.flexBasis = AUTO_VALUE
    this.markDirty()
  }
  setFlexWrap(wrap: Wrap): void {
    this.style.flexWrap = wrap
    this.markDirty()
  }

  // -- Style setters: alignment

  setAlignItems(a: Align): void {
    this.style.alignItems = a
    this.markDirty()
  }
  setAlignSelf(a: Align): void {
    this.style.alignSelf = a
    this.markDirty()
  }
  setAlignContent(a: Align): void {
    this.style.alignContent = a
    this.markDirty()
  }
  setJustifyContent(j: Justify): void {
    this.style.justifyContent = j
    this.markDirty()
  }

  // -- Style setters: display / position / overflow

  setDisplay(d: Display): void {
    this.style.display = d
    this.markDirty()
  }
  getDisplay(): Display {
    return this.style.display
  }
  setPositionType(t: PositionType): void {
    this.style.positionType = t
    this.markDirty()
  }
  setPosition(edge: Edge, v: number | string | undefined): void {
    this.style.position[edge] = parseDimension(v)
    this._hasPosition = hasAnyDefinedEdge(this.style.position)
    this.markDirty()
  }
  setPositionPercent(edge: Edge, v: number): void {
    this.style.position[edge] = percentValue(v)
    this._hasPosition = true
    this.markDirty()
  }
  setPositionAuto(edge: Edge): void {
    this.style.position[edge] = AUTO_VALUE
    this._hasPosition = true
    this.markDirty()
  }
  setOverflow(o: Overflow): void {
    this.style.overflow = o
    this.markDirty()
  }
  setDirection(d: Direction): void {
    this.style.direction = d
    this.markDirty()
  }
  setBoxSizing(_: BoxSizing): void {
    // 这里未实现，因为 Ink 不使用 content-box。
  }

  // -- Style setters: spacing

  setMargin(edge: Edge, v: number | 'auto' | string | undefined): void {
    const val = parseDimension(v)
    this.style.margin[edge] = val
    if (val.unit === Unit.Auto) this._hasAutoMargin = true
    else this._hasAutoMargin = hasAnyAutoEdge(this.style.margin)
    this._hasMargin =
      this._hasAutoMargin || hasAnyDefinedEdge(this.style.margin)
    this.markDirty()
  }
  setMarginPercent(edge: Edge, v: number): void {
    this.style.margin[edge] = percentValue(v)
    this._hasAutoMargin = hasAnyAutoEdge(this.style.margin)
    this._hasMargin = true
    this.markDirty()
  }
  setMarginAuto(edge: Edge): void {
    this.style.margin[edge] = AUTO_VALUE
    this._hasAutoMargin = true
    this._hasMargin = true
    this.markDirty()
  }
  setPadding(edge: Edge, v: number | string | undefined): void {
    this.style.padding[edge] = parseDimension(v)
    this._hasPadding = hasAnyDefinedEdge(this.style.padding)
    this.markDirty()
  }
  setPaddingPercent(edge: Edge, v: number): void {
    this.style.padding[edge] = percentValue(v)
    this._hasPadding = true
    this.markDirty()
  }
  setBorder(edge: Edge, v: number | undefined): void {
    this.style.border[edge] = v === undefined ? UNDEFINED_VALUE : pointValue(v)
    this._hasBorder = hasAnyDefinedEdge(this.style.border)
    this.markDirty()
  }
  setGap(gutter: Gutter, v: number | string | undefined): void {
    this.style.gap[gutter] = parseDimension(v)
    this.markDirty()
  }
  setGapPercent(gutter: Gutter, v: number): void {
    this.style.gap[gutter] = percentValue(v)
    this.markDirty()
  }

  // -- Style getters (partial — only what tests need)

  getFlexDirection(): FlexDirection {
    return this.style.flexDirection
  }
  getJustifyContent(): Justify {
    return this.style.justifyContent
  }
  getAlignItems(): Align {
    return this.style.alignItems
  }
  getAlignSelf(): Align {
    return this.style.alignSelf
  }
  getAlignContent(): Align {
    return this.style.alignContent
  }
  getFlexGrow(): number {
    return this.style.flexGrow
  }
  getFlexShrink(): number {
    return this.style.flexShrink
  }
  getFlexBasis(): Value {
    return this.style.flexBasis
  }
  getFlexWrap(): Wrap {
    return this.style.flexWrap
  }
  getWidth(): Value {
    return this.style.width
  }
  getHeight(): Value {
    return this.style.height
  }
  getOverflow(): Overflow {
    return this.style.overflow
  }
  getPositionType(): PositionType {
    return this.style.positionType
  }
  getDirection(): Direction {
    return this.style.direction
  }

  // -- Unused API stubs (present for API parity)

  copyStyle(_: Node): void {}
  setDirtiedFunc(_: unknown): void {}
  unsetDirtiedFunc(): void {}
  setIsReferenceBaseline(v: boolean): void {
    this.isReferenceBaseline_ = v
    this.markDirty()
  }
  isReferenceBaseline(): boolean {
    return this.isReferenceBaseline_
  }
  setAspectRatio(_: number | undefined): void {}
  getAspectRatio(): number {
    return NaN
  }
  setAlwaysFormsContainingBlock(_: boolean): void {}

  // -- Layout entry point

  calculateLayout(
    ownerWidth: number | undefined,
    ownerHeight: number | undefined,
    _direction?: Direction,
  ): void {
    _yogaNodesVisited = 0
    _yogaMeasureCalls = 0
    _yogaCacheHits = 0
    _generation++
    const w = ownerWidth === undefined ? NaN : ownerWidth
    const h = ownerHeight === undefined ? NaN : ownerHeight
    layoutNode(
      this,
      w,
      h,
      isDefined(w) ? MeasureMode.Exactly : MeasureMode.Undefined,
      isDefined(h) ? MeasureMode.Exactly : MeasureMode.Undefined,
      w,
      h,
      true,
    )
    // root 自身的位置 = margin + position inset。
    // yoga 即便在 root 没有父容器时也会对其应用 position；
    // 这会影响后续 rounding，因为 root 的绝对 top/left 是像素网格遍历的起点。
    const mar = this.layout.margin
    const posL = resolveValue(
      resolveEdgeRaw(this.style.position, EDGE_LEFT),
      isDefined(w) ? w : 0,
    )
    const posT = resolveValue(
      resolveEdgeRaw(this.style.position, EDGE_TOP),
      isDefined(w) ? w : 0,
    )
    this.layout.left = mar[EDGE_LEFT] + (isDefined(posL) ? posL : 0)
    this.layout.top = mar[EDGE_TOP] + (isDefined(posT) ? posT : 0)
    roundLayout(this, this.config.pointScaleFactor, 0, 0)
  }
}

const DEFAULT_CONFIG = createConfig()

const CACHE_SLOTS = 4
function cacheWrite(
  node: Node,
  aW: number,
  aH: number,
  wM: MeasureMode,
  hM: MeasureMode,
  oW: number,
  oH: number,
  fW: boolean,
  fH: boolean,
  wasDirty: boolean,
): void {
  if (!node._cIn) {
    node._cIn = new Float64Array(CACHE_SLOTS * 8)
    node._cOut = new Float64Array(CACHE_SLOTS * 2)
  }
  // 节点变脏后的第一次写入，会清掉脏之前留下的陈旧缓存。
  // _cGen < _generation 说明这些条目来自更早一次 calculateLayout；
  // 如果 wasDirty 为真，子树自那以后已经变化，旧尺寸自然失效。
  // 干净节点的旧条目则可以保留，因为同一棵子树面对相同输入会得到相同结果，
  // 这使得跨 generation 的缓存依然有效。
  if (wasDirty && node._cGen !== _generation) {
    node._cN = 0
    node._cWr = 0
  }
  // LRU 写入索引会回卷；_cN 维持在 CACHE_SLOTS，
  // 这样读取扫描时始终会检查所有已填充槽位，而不是只检查最近一圈。
  const i = node._cWr++ % CACHE_SLOTS
  if (node._cN < CACHE_SLOTS) node._cN = node._cWr
  const o = i * 8
  const cIn = node._cIn
  cIn[o] = aW
  cIn[o + 1] = aH
  cIn[o + 2] = wM
  cIn[o + 3] = hM
  cIn[o + 4] = oW
  cIn[o + 5] = oH
  cIn[o + 6] = fW ? 1 : 0
  cIn[o + 7] = fH ? 1 : 0
  node._cOut![i * 2] = node.layout.width
  node._cOut![i * 2 + 1] = node.layout.height
  node._cGen = _generation
}

// 把计算后的 layout.width/height 写入单槽缓存的输出字段。
// _hasL/_hasM 的输入会在 layoutNode 顶部（计算前）写入；
// 而输出必须在这里（计算后）提交，这样缓存命中时才能恢复正确尺寸。
// 否则 _hasL 命中读到的只会是上一次遗留的 layout.width/height，
// 它有可能是 heightMode=Undefined 的 measure 阶段得到的内容高度，
// 而不是 layout 阶段的受约束视口高度。
// 这就是 scrollbox 的 vpH=33→2624 问题：scrollTop 被夹到 0，视口变空白。
function commitCacheOutputs(node: Node, performLayout: boolean): void {
  if (performLayout) {
    node._lOutW = node.layout.width
    node._lOutH = node.layout.height
  } else {
    node._mOutW = node.layout.width
    node._mOutH = node.layout.height
  }
}

// --
// flexbox 核心算法

// profiling 计数器：每次 calculateLayout 时重置，通过 getYogaCounters 读取。
// _generation 会在每次 calculateLayout 时递增；节点写缓存时会记录 _fbGen/_cGen。
// 如果缓存条目的 gen === _generation，就表示它是在本轮计算中得到的，
// 无论 isDirty_ 状态如何，都可以视为新鲜结果。
let _generation = 0
let _yogaNodesVisited = 0
let _yogaMeasureCalls = 0
let _yogaCacheHits = 0
let _yogaLiveNodes = 0
export function getYogaCounters(): {
  visited: number
  measured: number
  cacheHits: number
  live: number
} {
  return {
    visited: _yogaNodesVisited,
    measured: _yogaMeasureCalls,
    cacheHits: _yogaCacheHits,
    live: _yogaLiveNodes,
  }
}

function layoutNode(
  node: Node,
  availableWidth: number,
  availableHeight: number,
  widthMode: MeasureMode,
  heightMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
  performLayout: boolean,
  // 为 true 时，忽略该轴上的 style dimension，
  // 因为 flex 容器已经决定了主轴尺寸（来自 flex-basis + grow/shrink 结果）。
  forceWidth = false,
  forceHeight = false,
): void {
  _yogaNodesVisited++
  const style = node.style
  const layout = node.layout

  // dirty 标记短路：当子树是干净的且输入匹配时，layout 对象本身就已经持有答案。
  // layout 缓存也可以满足 measure 请求（因为位置是尺寸的超集），反过来则不成立。
  // 同一 generation 的条目总是新鲜的，因为它们就是本轮 calculateLayout 里算出来的。
  // 上一代的条目则要求节点不是脏的，否则说明脏之前的缓存已经失效。
  // sameGen 只对 MEASURE 调用开放；若在 layout 阶段直接命中缓存，
  // 会跳过对子节点位置的递归计算，导致子节点停留在旧位置。
  const sameGen = node._cGen === _generation && !performLayout
  if (!node.isDirty_ || sameGen) {
    if (
      !node.isDirty_ &&
      node._hasL &&
      node._lWM === widthMode &&
      node._lHM === heightMode &&
      node._lFW === forceWidth &&
      node._lFH === forceHeight &&
      sameFloat(node._lW, availableWidth) &&
      sameFloat(node._lH, availableHeight) &&
      sameFloat(node._lOW, ownerWidth) &&
      sameFloat(node._lOH, ownerHeight)
    ) {
      _yogaCacheHits++
      layout.width = node._lOutW
      layout.height = node._lOutH
      return
    }
    // 多槽缓存：扫描匹配输入，命中后恢复缓存的 w/h。
    // 它覆盖了滚动场景下的关键问题：脏祖先触发的 measure→layout 级联，
    // 会让同一个干净子节点面对多个不同输入组合；单槽 _hasL 会被反复冲掉，
    // 迫使整棵子树重新递归。
    // 引入多槽后，500 条消息的 scrollbox 且只有一个脏叶子时，
    // dirty-leaf relayout 从 76k 次 layoutNode 调用降到 4k，
    // 约 6.86ms 降到 550µs。
    // same-generation 检查还能覆盖虚拟滚动中新挂载的脏节点：
    // 脏链会反复调用它们，第一次写缓存，后续全部命中。
    if (node._cN > 0 && (sameGen || !node.isDirty_)) {
      const cIn = node._cIn!
      for (let i = 0; i < node._cN; i++) {
        const o = i * 8
        if (
          cIn[o + 2] === widthMode &&
          cIn[o + 3] === heightMode &&
          cIn[o + 6] === (forceWidth ? 1 : 0) &&
          cIn[o + 7] === (forceHeight ? 1 : 0) &&
          sameFloat(cIn[o]!, availableWidth) &&
          sameFloat(cIn[o + 1]!, availableHeight) &&
          sameFloat(cIn[o + 4]!, ownerWidth) &&
          sameFloat(cIn[o + 5]!, ownerHeight)
        ) {
          layout.width = node._cOut![i * 2]!
          layout.height = node._cOut![i * 2 + 1]!
          _yogaCacheHits++
          return
        }
      }
    }
    if (
      !node.isDirty_ &&
      !performLayout &&
      node._hasM &&
      node._mWM === widthMode &&
      node._mHM === heightMode &&
      sameFloat(node._mW, availableWidth) &&
      sameFloat(node._mH, availableHeight) &&
      sameFloat(node._mOW, ownerWidth) &&
      sameFloat(node._mOH, ownerHeight)
    ) {
      layout.width = node._mOutW
      layout.height = node._mOutH
      _yogaCacheHits++
      return
    }
  }
  // 先提交缓存输入，确保任意 return 路径都会留下合法缓存条目。
  // 只有在 LAYOUT 阶段才清 isDirty_。measure 阶段
  // （computeFlexBasis → layoutNode(performLayout=false)）会在同一次
  // calculateLayout 中先于 layout 阶段执行。
  // 如果在 measure 时就清掉 dirty，后续 layout 阶段会错误命中上一次
  // calculateLayout 留下的陈旧 _hasL 缓存（那时子节点甚至还没插入完成），
  // 从而导致 ScrollBox 内容高度不再增长，sticky-scroll 也无法跟随新内容。
  // 脏节点的 _hasL 条目按定义就是过期的，因此这里必须让 layout 阶段重新计算。
  const wasDirty = node.isDirty_
  if (performLayout) {
    node._lW = availableWidth
    node._lH = availableHeight
    node._lWM = widthMode
    node._lHM = heightMode
    node._lOW = ownerWidth
    node._lOH = ownerHeight
    node._lFW = forceWidth
    node._lFH = forceHeight
    node._hasL = true
    node.isDirty_ = false
    // 旧做法会在这里清空 _cN，以阻止脏之前的旧条目命中
    // （对应 long-continuous blank-screen bug）。
    // 现在改用 generation 标记：缓存检查要求 sameGen || !isDirty_，
    // 因此来自旧 generation 的脏节点条目本就不会命中。
    // 如果这里继续清空，反而会把稍早 measure 阶段生成的同代新鲜条目抹掉，
    // 迫使 layout 阶段再次重算。
    if (wasDirty) node._hasM = false
  } else {
    node._mW = availableWidth
    node._mH = availableHeight
    node._mWM = widthMode
    node._mHM = heightMode
    node._mOW = ownerWidth
    node._mOH = ownerHeight
    node._hasM = true
    // 不要清 isDirty_。
    // 对 DIRTY 节点来说，需要让 _hasL 失效，这样紧接着的 performLayout=true
    // 调用才会基于新的子节点集合重新计算
    // （否则 sticky-scroll 仍然无法跟随新内容，这就是 4557bc9f9c 的问题）。
    // 干净节点则保留 _hasL：它们上一代的布局依然有效，只是因为祖先变脏，
    // 才以不同于缓存的输入再次进入这里。
    if (wasDirty) node._hasL = false
  }

  // 按 ownerWidth 解析 padding/border/margin（yoga 对百分比也使用 ownerWidth）。
  // 这里直接写入预分配好的 layout 数组，避免每次 layoutNode 调用额外分配 3 个数组，
  // 以及 12 次 resolveEdge 调用（它曾是 CPU profile 里的头号热点）。
  // 如果根本没设置边，就完全跳过；直接 4 次写零，比 resolveEdges4Into
  // 为了产出这些零而做的约 20 次读取和 15 次比较更便宜。
  const pad = layout.padding
  const bor = layout.border
  const mar = layout.margin
  if (node._hasPadding) resolveEdges4Into(style.padding, ownerWidth, pad)
  else pad[0] = pad[1] = pad[2] = pad[3] = 0
  if (node._hasBorder) resolveEdges4Into(style.border, ownerWidth, bor)
  else bor[0] = bor[1] = bor[2] = bor[3] = 0
  if (node._hasMargin) resolveEdges4Into(style.margin, ownerWidth, mar)
  else mar[0] = mar[1] = mar[2] = mar[3] = 0

  const paddingBorderWidth = pad[0] + pad[2] + bor[0] + bor[2]
  const paddingBorderHeight = pad[1] + pad[3] + bor[1] + bor[3]

  // 解析 style 上声明的尺寸。
  const styleWidth = forceWidth ? NaN : resolveValue(style.width, ownerWidth)
  const styleHeight = forceHeight
    ? NaN
    : resolveValue(style.height, ownerHeight)

  // 如果 style dimension 已定义，它会覆盖传入的 available size。
  let width = availableWidth
  let height = availableHeight
  let wMode = widthMode
  let hMode = heightMode
  if (isDefined(styleWidth)) {
    width = styleWidth
    wMode = MeasureMode.Exactly
  }
  if (isDefined(styleHeight)) {
    height = styleHeight
    hMode = MeasureMode.Exactly
  }

  // 对节点自身尺寸应用 min/max 约束。
  width = boundAxis(style, true, width, ownerWidth, ownerHeight)
  height = boundAxis(style, false, height, ownerWidth, ownerHeight)

  // 带 measure function 的叶子节点。
  if (node.measureFunc && node.children.length === 0) {
    const innerW =
      wMode === MeasureMode.Undefined
        ? NaN
        : Math.max(0, width - paddingBorderWidth)
    const innerH =
      hMode === MeasureMode.Undefined
        ? NaN
        : Math.max(0, height - paddingBorderHeight)
    _yogaMeasureCalls++
    const measured = node.measureFunc(innerW, wMode, innerH, hMode)
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : boundAxis(
            style,
            true,
            (measured.width ?? 0) + paddingBorderWidth,
            ownerWidth,
            ownerHeight,
          )
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : boundAxis(
            style,
            false,
            (measured.height ?? 0) + paddingBorderHeight,
            ownerWidth,
            ownerHeight,
          )
    commitCacheOutputs(node, performLayout)
    // 即便节点是脏的，也要写缓存。
    // 虚拟滚动中新挂载的条目在首次布局时天然是脏的，但脏链的 measure→layout
    // 级联会在一次 calculateLayout 中多次调用它们。
    // 这里写缓存后，第 2 次及之后的调用就能直接命中。
    cacheWrite(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    )
    return
  }

  // 没有子节点、也没有 measure function 的普通叶子节点。
  if (node.children.length === 0) {
    node.layout.width =
      wMode === MeasureMode.Exactly
        ? width
        : boundAxis(style, true, paddingBorderWidth, ownerWidth, ownerHeight)
    node.layout.height =
      hMode === MeasureMode.Exactly
        ? height
        : boundAxis(style, false, paddingBorderHeight, ownerWidth, ownerHeight)
    commitCacheOutputs(node, performLayout)
    // 同样，即便节点是脏的，也要写缓存。
    // 对 fresh mount 节点来说，这能把同一轮 calculateLayout 中的后续调用短路掉。
    cacheWrite(
      node,
      availableWidth,
      availableHeight,
      widthMode,
      heightMode,
      ownerWidth,
      ownerHeight,
      forceWidth,
      forceHeight,
      wasDirty,
    )
    return
  }

  // 带子节点的容器，开始执行 flexbox 算法。
  const mainAxis = style.flexDirection
  const crossAx = crossAxis(mainAxis)
  const isMainRow = isRow(mainAxis)

  const mainSize = isMainRow ? width : height
  const crossSize = isMainRow ? height : width
  const mainMode = isMainRow ? wMode : hMode
  const crossMode = isMainRow ? hMode : wMode
  const mainPadBorder = isMainRow ? paddingBorderWidth : paddingBorderHeight
  const crossPadBorder = isMainRow ? paddingBorderHeight : paddingBorderWidth

  const innerMainSize = isDefined(mainSize)
    ? Math.max(0, mainSize - mainPadBorder)
    : NaN
  const innerCrossSize = isDefined(crossSize)
    ? Math.max(0, crossSize - crossPadBorder)
    : NaN

  // 解析 gap。
  const gapMain = resolveGap(
    style,
    isMainRow ? Gutter.Column : Gutter.Row,
    innerMainSize,
  )

  // 把子节点划分为 flow 与 absolute 两类。
  // display:contents 节点在这里是“透明”的：它的孩子会递归提升到祖父节点的子列表中，
  // 而 contents 节点自己则得到零布局。
  const flowChildren: Node[] = []
  const absChildren: Node[] = []
  collectLayoutChildren(node, flowChildren, absChildren)

  // ownerW/H 是解析子节点百分比值时使用的参考尺寸。
  // 按 CSS 规则，百分比宽度要相对于父节点 content-box 宽度解析。
  // 如果当前节点宽度本身是不确定的，那么子节点的百分比宽度也必须保持不确定，
  // 不能继续退回到祖父节点尺寸。
  const ownerW = isDefined(width) ? width : NaN
  const ownerH = isDefined(height) ? height : NaN
  const isWrap = style.flexWrap !== Wrap.NoWrap
  const gapCross = resolveGap(
    style,
    isMainRow ? Gutter.Row : Gutter.Column,
    innerCrossSize,
  )

  // STEP 1：为每个 flow child 计算 flex-basis，并按需要分行。
  // 单行容器（NoWrap）总是只有一行；多行容器会在累计 basis+margin+gap
  // 超过 innerMainSize 时换行。
  for (const c of flowChildren) {
    c._flexBasis = computeFlexBasis(
      c,
      mainAxis,
      innerMainSize,
      innerCrossSize,
      crossMode,
      ownerW,
      ownerH,
    )
  }
  const lines: Node[][] = []
  if (!isWrap || !isDefined(innerMainSize) || flowChildren.length === 0) {
    for (const c of flowChildren) c._lineIndex = 0
    lines.push(flowChildren)
  } else {
    // 换行决策使用的是经过 min/max 钳制后的 basis
    // （flexbox 规范 §9.3.5 中的 hypothetical main size），
    // 而不是原始 flex-basis。
    let lineStart = 0
    let lineLen = 0
    for (let i = 0; i < flowChildren.length; i++) {
      const c = flowChildren[i]!
      const hypo = boundAxis(c.style, isMainRow, c._flexBasis, ownerW, ownerH)
      const outer = Math.max(0, hypo) + childMarginForAxis(c, mainAxis, ownerW)
      const withGap = i > lineStart ? gapMain : 0
      if (i > lineStart && lineLen + withGap + outer > innerMainSize) {
        lines.push(flowChildren.slice(lineStart, i))
        lineStart = i
        lineLen = outer
      } else {
        lineLen += withGap + outer
      }
      c._lineIndex = lines.length
    }
    lines.push(flowChildren.slice(lineStart))
  }
  const lineCount = lines.length
  const isBaseline = isBaselineLayout(node, flowChildren)

  // STEP 2+3：对每一行分别解析可伸缩长度，并布局子节点以测量 cross size。
  // 同时记录每一行消耗的 main size 与最大 cross size。
  const lineConsumedMain: number[] = new Array(lineCount)
  const lineCrossSizes: number[] = new Array(lineCount)
  // Baseline 布局会为每一行记录最大 ascent（baseline + leading margin），
  // 这样 baseline 对齐的子项就能放到 maxAscent - childBaseline 的位置。
  const lineMaxAscent: number[] = isBaseline ? new Array(lineCount).fill(0) : []
  let maxLineMain = 0
  let totalLinesCross = 0
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!
    const lineGap = line.length > 1 ? gapMain * (line.length - 1) : 0
    let lineBasis = lineGap
    for (const c of line) {
      lineBasis += c._flexBasis + childMarginForAxis(c, mainAxis, ownerW)
    }
    // 根据可用 inner main 解析柔性长度。
    // 若容器 main size 不确定但带 min/max，则要基于钳制后的尺寸做 flex 计算。
    let availMain = innerMainSize
    if (!isDefined(availMain)) {
      const mainOwner = isMainRow ? ownerWidth : ownerHeight
      const minM = resolveValue(
        isMainRow ? style.minWidth : style.minHeight,
        mainOwner,
      )
      const maxM = resolveValue(
        isMainRow ? style.maxWidth : style.maxHeight,
        mainOwner,
      )
      if (isDefined(maxM) && lineBasis > maxM - mainPadBorder) {
        availMain = Math.max(0, maxM - mainPadBorder)
      } else if (isDefined(minM) && lineBasis < minM - mainPadBorder) {
        availMain = Math.max(0, minM - mainPadBorder)
      }
    }
    resolveFlexibleLengths(
      line,
      availMain,
      lineBasis,
      isMainRow,
      ownerW,
      ownerH,
    )

    // 布局本行每个子节点，以测量 cross 尺寸。
    let lineCross = 0
    for (const c of line) {
      const cStyle = c.style
      const childAlign =
        cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf
      const cMarginCross = childMarginForAxis(c, crossAx, ownerW)
      let childCrossSize = NaN
      let childCrossMode: MeasureMode = MeasureMode.Undefined
      const resolvedCrossStyle = resolveValue(
        isMainRow ? cStyle.height : cStyle.width,
        isMainRow ? ownerH : ownerW,
      )
      const crossLeadE = isMainRow ? EDGE_TOP : EDGE_LEFT
      const crossTrailE = isMainRow ? EDGE_BOTTOM : EDGE_RIGHT
      const hasCrossAutoMargin =
        c._hasAutoMargin &&
        (isMarginAuto(cStyle.margin, crossLeadE) ||
          isMarginAuto(cStyle.margin, crossTrailE))
      // 单行 stretch 可以直接拉到容器 cross size。
      // 多行 wrap 则先按 intrinsic cross（Undefined 模式）测量，
      // 这样 flex-grow 的孙节点不会过早撑满容器；
      // 先定出 line cross size，再回头做 stretch。
      if (isDefined(resolvedCrossStyle)) {
        childCrossSize = resolvedCrossStyle
        childCrossMode = MeasureMode.Exactly
      } else if (
        childAlign === Align.Stretch &&
        !hasCrossAutoMargin &&
        !isWrap &&
        isDefined(innerCrossSize) &&
        crossMode === MeasureMode.Exactly
      ) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross)
        childCrossMode = MeasureMode.Exactly
      } else if (!isWrap && isDefined(innerCrossSize)) {
        childCrossSize = Math.max(0, innerCrossSize - cMarginCross)
        childCrossMode = MeasureMode.AtMost
      }
      const cw = isMainRow ? c._mainSize : childCrossSize
      const ch = isMainRow ? childCrossSize : c._mainSize
      layoutNode(
        c,
        cw,
        ch,
        isMainRow ? MeasureMode.Exactly : childCrossMode,
        isMainRow ? childCrossMode : MeasureMode.Exactly,
        ownerW,
        ownerH,
        performLayout,
        isMainRow,
        !isMainRow,
      )
      c._crossSize = isMainRow ? c.layout.height : c.layout.width
      lineCross = Math.max(lineCross, c._crossSize + cMarginCross)
    }
    // Baseline 布局下，line cross size 至少要容纳 baseline 对齐子节点的
    // maxAscent + maxDescent（对应 yoga 的 STEP 8），且仅适用于 row 方向。
    if (isBaseline) {
      let maxAscent = 0
      let maxDescent = 0
      for (const c of line) {
        if (resolveChildAlign(node, c) !== Align.Baseline) continue
        const mTop = resolveEdge(c.style.margin, EDGE_TOP, ownerW)
        const mBot = resolveEdge(c.style.margin, EDGE_BOTTOM, ownerW)
        const ascent = calculateBaseline(c) + mTop
        const descent = c.layout.height + mTop + mBot - ascent
        if (ascent > maxAscent) maxAscent = ascent
        if (descent > maxDescent) maxDescent = descent
      }
      lineMaxAscent[li] = maxAscent
      if (maxAscent + maxDescent > lineCross) {
        lineCross = maxAscent + maxDescent
      }
    }
    // 上面大约第 1117 行处对 layoutNode(c) 的调用，已经用相同 ownerW
    // 通过 resolveEdges4Into 解析过 c.layout.margin[]，
    // 因此这里直接读取结果即可，不必再经 childMarginForAxis 重走 2 次 resolveEdge。
    const mainLead = leadingEdge(mainAxis)
    const mainTrail = trailingEdge(mainAxis)
    let consumed = lineGap
    for (const c of line) {
      const cm = c.layout.margin
      consumed += c._mainSize + cm[mainLead]! + cm[mainTrail]!
    }
    lineConsumedMain[li] = consumed
    lineCrossSizes[li] = lineCross
    maxLineMain = Math.max(maxLineMain, consumed)
    totalLinesCross += lineCross
  }
  const totalCrossGap = lineCount > 1 ? gapCross * (lineCount - 1) : 0
  totalLinesCross += totalCrossGap

  // STEP 4：确定容器尺寸。
  // 按 yoga 的 STEP 9，对于 AtMost（FitContent）与 Undefined（MaxContent），
  // 节点都应按内容定尺寸；AtMost 并不是硬性钳制，子项仍可溢出可用空间
  // （即 CSS 的 fit-content 语义）。只有 Scroll overflow 会钳制到可用尺寸。
  // 若 wrap 容器在 AtMost 下已经分成多行，则其 main size 填满该可用边界。
  const isScroll = style.overflow === Overflow.Scroll
  const contentMain = maxLineMain + mainPadBorder
  const finalMainSize =
    mainMode === MeasureMode.Exactly
      ? mainSize
      : mainMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(mainSize, contentMain), mainPadBorder)
        : isWrap && lineCount > 1 && mainMode === MeasureMode.AtMost
          ? mainSize
          : contentMain
  const contentCross = totalLinesCross + crossPadBorder
  const finalCrossSize =
    crossMode === MeasureMode.Exactly
      ? crossSize
      : crossMode === MeasureMode.AtMost && isScroll
        ? Math.max(Math.min(crossSize, contentCross), crossPadBorder)
        : contentCross
  node.layout.width = boundAxis(
    style,
    true,
    isMainRow ? finalMainSize : finalCrossSize,
    ownerWidth,
    ownerHeight,
  )
  node.layout.height = boundAxis(
    style,
    false,
    isMainRow ? finalCrossSize : finalMainSize,
    ownerWidth,
    ownerHeight,
  )
  commitCacheOutputs(node, performLayout)
  // 即便节点是脏的，也要写缓存，这对虚拟滚动中的 fresh mount 场景非常关键。
  cacheWrite(
    node,
    availableWidth,
    availableHeight,
    widthMode,
    heightMode,
    ownerWidth,
    ownerHeight,
    forceWidth,
    forceHeight,
    wasDirty,
  )

  if (!performLayout) return

  // STEP 5：定位各行（align-content）以及子节点
  // （justify-content + align-items + auto margins）。
  const actualInnerMain =
    (isMainRow ? node.layout.width : node.layout.height) - mainPadBorder
  const actualInnerCross =
    (isMainRow ? node.layout.height : node.layout.width) - crossPadBorder
  const mainLeadEdgePhys = leadingEdge(mainAxis)
  const mainTrailEdgePhys = trailingEdge(mainAxis)
  const crossLeadEdgePhys = isMainRow ? EDGE_TOP : EDGE_LEFT
  const crossTrailEdgePhys = isMainRow ? EDGE_BOTTOM : EDGE_RIGHT
  const reversed = isReverse(mainAxis)
  const mainContainerSize = isMainRow ? node.layout.width : node.layout.height
  const crossLead = pad[crossLeadEdgePhys]! + bor[crossLeadEdgePhys]!

  // align-content：把剩余 cross 空间分配给各行。
  // 单行容器会把整段 cross size 都给这一行，行内定位则由 align-items 负责。
  let lineCrossOffset = crossLead
  let betweenLines = gapCross
  const freeCross = actualInnerCross - totalLinesCross
  if (lineCount === 1 && !isWrap && !isBaseline) {
    lineCrossSizes[0] = actualInnerCross
  } else {
    const remCross = Math.max(0, freeCross)
    switch (style.alignContent) {
      case Align.FlexStart:
        break
      case Align.Center:
        lineCrossOffset += freeCross / 2
        break
      case Align.FlexEnd:
        lineCrossOffset += freeCross
        break
      case Align.Stretch:
        if (lineCount > 0 && remCross > 0) {
          const add = remCross / lineCount
          for (let i = 0; i < lineCount; i++) lineCrossSizes[i]! += add
        }
        break
      case Align.SpaceBetween:
        if (lineCount > 1) betweenLines += remCross / (lineCount - 1)
        break
      case Align.SpaceAround:
        if (lineCount > 0) {
          betweenLines += remCross / lineCount
          lineCrossOffset += remCross / lineCount / 2
        }
        break
      case Align.SpaceEvenly:
        if (lineCount > 0) {
          betweenLines += remCross / (lineCount + 1)
          lineCrossOffset += remCross / (lineCount + 1)
        }
        break
      default:
        break
    }
  }

  // 对 wrap-reverse，行会从 trailing cross edge 开始堆叠。
  // 遍历顺序不变，但容器内部的 cross 位置需要翻转。
  const wrapReverse = style.flexWrap === Wrap.WrapReverse
  const crossContainerSize = isMainRow ? node.layout.height : node.layout.width
  let lineCrossPos = lineCrossOffset
  for (let li = 0; li < lineCount; li++) {
    const line = lines[li]!
    const lineCross = lineCrossSizes[li]!
    const consumedMain = lineConsumedMain[li]!
    const n = line.length

    // 现在 line cross size 已知，可以把那些 cross 为 auto 且 align=stretch 的子项重新拉伸。
    // 这对多行 wrap 必不可少，因为初次 measure 时 line cross 尚未确定；
    // 对单行且容器 cross 不是 Exactly 的情况也同样需要。
    if (isWrap || crossMode !== MeasureMode.Exactly) {
      for (const c of line) {
        const cStyle = c.style
        const childAlign =
          cStyle.alignSelf === Align.Auto ? style.alignItems : cStyle.alignSelf
        const crossStyleDef = isDefined(
          resolveValue(
            isMainRow ? cStyle.height : cStyle.width,
            isMainRow ? ownerH : ownerW,
          ),
        )
        const hasCrossAutoMargin =
          c._hasAutoMargin &&
          (isMarginAuto(cStyle.margin, crossLeadEdgePhys) ||
            isMarginAuto(cStyle.margin, crossTrailEdgePhys))
        if (
          childAlign === Align.Stretch &&
          !crossStyleDef &&
          !hasCrossAutoMargin
        ) {
          const cMarginCross = childMarginForAxis(c, crossAx, ownerW)
          const target = Math.max(0, lineCross - cMarginCross)
          if (c._crossSize !== target) {
            const cw = isMainRow ? c._mainSize : target
            const ch = isMainRow ? target : c._mainSize
            layoutNode(
              c,
              cw,
              ch,
              MeasureMode.Exactly,
              MeasureMode.Exactly,
              ownerW,
              ownerH,
              performLayout,
              isMainRow,
              !isMainRow,
            )
            c._crossSize = target
          }
        }
      }
    }

    // 处理当前行的 justify-content 与 auto margin。
    let mainOffset = pad[mainLeadEdgePhys]! + bor[mainLeadEdgePhys]!
    let betweenMain = gapMain
    let numAutoMarginsMain = 0
    for (const c of line) {
      if (!c._hasAutoMargin) continue
      if (isMarginAuto(c.style.margin, mainLeadEdgePhys)) numAutoMarginsMain++
      if (isMarginAuto(c.style.margin, mainTrailEdgePhys)) numAutoMarginsMain++
    }
    const freeMain = actualInnerMain - consumedMain
    const remainingMain = Math.max(0, freeMain)
    const autoMarginMainSize =
      numAutoMarginsMain > 0 && remainingMain > 0
        ? remainingMain / numAutoMarginsMain
        : 0
    if (numAutoMarginsMain === 0) {
      switch (style.justifyContent) {
        case Justify.FlexStart:
          break
        case Justify.Center:
          mainOffset += freeMain / 2
          break
        case Justify.FlexEnd:
          mainOffset += freeMain
          break
        case Justify.SpaceBetween:
          if (n > 1) betweenMain += remainingMain / (n - 1)
          break
        case Justify.SpaceAround:
          if (n > 0) {
            betweenMain += remainingMain / n
            mainOffset += remainingMain / n / 2
          }
          break
        case Justify.SpaceEvenly:
          if (n > 0) {
            betweenMain += remainingMain / (n + 1)
            mainOffset += remainingMain / (n + 1)
          }
          break
      }
    }

    const effectiveLineCrossPos = wrapReverse
      ? crossContainerSize - lineCrossPos - lineCross
      : lineCrossPos

    let pos = mainOffset
    for (const c of line) {
      const cMargin = c.style.margin
      // c.layout.margin[] 已在上面的 layoutNode(c) 调用中通过 resolveEdges4Into
      // 以相同 ownerW 填充好，因此这里直接读解析后的值即可，
      // 无需再额外重跑 4 次 resolveEdge 的 fallback 链。
      // auto margin 在 layout.margin 中会表现为 0，
      // 因此 autoMarginMainSize 的替换仍要基于 style 上的 isMarginAuto 判断。
      const cLayoutMargin = c.layout.margin
      let autoMainLead = false
      let autoMainTrail = false
      let autoCrossLead = false
      let autoCrossTrail = false
      let mMainLead: number
      let mMainTrail: number
      let mCrossLead: number
      let mCrossTrail: number
      if (c._hasAutoMargin) {
        autoMainLead = isMarginAuto(cMargin, mainLeadEdgePhys)
        autoMainTrail = isMarginAuto(cMargin, mainTrailEdgePhys)
        autoCrossLead = isMarginAuto(cMargin, crossLeadEdgePhys)
        autoCrossTrail = isMarginAuto(cMargin, crossTrailEdgePhys)
        mMainLead = autoMainLead
          ? autoMarginMainSize
          : cLayoutMargin[mainLeadEdgePhys]!
        mMainTrail = autoMainTrail
          ? autoMarginMainSize
          : cLayoutMargin[mainTrailEdgePhys]!
        mCrossLead = autoCrossLead ? 0 : cLayoutMargin[crossLeadEdgePhys]!
        mCrossTrail = autoCrossTrail ? 0 : cLayoutMargin[crossTrailEdgePhys]!
      } else {
        // 快路径：没有 auto margin 时，直接读取已解析值。
        mMainLead = cLayoutMargin[mainLeadEdgePhys]!
        mMainTrail = cLayoutMargin[mainTrailEdgePhys]!
        mCrossLead = cLayoutMargin[crossLeadEdgePhys]!
        mCrossTrail = cLayoutMargin[crossTrailEdgePhys]!
      }

      const mainPos = reversed
        ? mainContainerSize - (pos + mMainLead) - c._mainSize
        : pos + mMainLead

      const childAlign =
        c.style.alignSelf === Align.Auto ? style.alignItems : c.style.alignSelf
      let crossPos = effectiveLineCrossPos + mCrossLead
      const crossFree = lineCross - c._crossSize - mCrossLead - mCrossTrail
      if (autoCrossLead && autoCrossTrail) {
        crossPos += Math.max(0, crossFree) / 2
      } else if (autoCrossLead) {
        crossPos += Math.max(0, crossFree)
      } else if (autoCrossTrail) {
        // 保持在 leading 位置。
      } else {
        switch (childAlign) {
          case Align.FlexStart:
          case Align.Stretch:
            if (wrapReverse) crossPos += crossFree
            break
          case Align.Center:
            crossPos += crossFree / 2
            break
          case Align.FlexEnd:
            if (!wrapReverse) crossPos += crossFree
            break
          case Align.Baseline:
            // 仅适用于 row 方向（isBaselineLayout 已保证）。
            // 这里要把子节点的 baseline 对齐到当前行的 max ascent。
            // 按 yoga 的公式：top = currentLead + maxAscent - childBaseline + leadingPosition。
            if (isBaseline) {
              crossPos =
                effectiveLineCrossPos +
                lineMaxAscent[li]! -
                calculateBaseline(c)
            }
            break
          default:
            break
        }
      }

      // 相对定位偏移。快路径下如果根本没设置 position inset，
      // 就直接跳过 4 次 resolveEdgeRaw、4 次 resolveValue 和 4 次 isDefined。
      let relX = 0
      let relY = 0
      if (c._hasPosition) {
        const relLeft = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_LEFT),
          ownerW,
        )
        const relRight = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_RIGHT),
          ownerW,
        )
        const relTop = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_TOP),
          ownerW,
        )
        const relBottom = resolveValue(
          resolveEdgeRaw(c.style.position, EDGE_BOTTOM),
          ownerW,
        )
        relX = isDefined(relLeft)
          ? relLeft
          : isDefined(relRight)
            ? -relRight
            : 0
        relY = isDefined(relTop)
          ? relTop
          : isDefined(relBottom)
            ? -relBottom
            : 0
      }

      if (isMainRow) {
        c.layout.left = mainPos + relX
        c.layout.top = crossPos + relY
      } else {
        c.layout.left = crossPos + relX
        c.layout.top = mainPos + relY
      }
      pos += c._mainSize + mMainLead + mMainTrail + betweenMain
    }
    lineCrossPos += lineCross + betweenLines
  }

  // STEP 6：处理绝对定位子节点。
  for (const c of absChildren) {
    layoutAbsoluteChild(
      node,
      c,
      node.layout.width,
      node.layout.height,
      pad,
      bor,
    )
  }
}

function layoutAbsoluteChild(
  parent: Node,
  child: Node,
  parentWidth: number,
  parentHeight: number,
  pad: [number, number, number, number],
  bor: [number, number, number, number],
): void {
  const cs = child.style
  const posLeft = resolveEdgeRaw(cs.position, EDGE_LEFT)
  const posRight = resolveEdgeRaw(cs.position, EDGE_RIGHT)
  const posTop = resolveEdgeRaw(cs.position, EDGE_TOP)
  const posBottom = resolveEdgeRaw(cs.position, EDGE_BOTTOM)

  const rLeft = resolveValue(posLeft, parentWidth)
  const rRight = resolveValue(posRight, parentWidth)
  const rTop = resolveValue(posTop, parentHeight)
  const rBottom = resolveValue(posBottom, parentHeight)

  // 绝对定位子节点的百分比尺寸，按 containing block 的 padding-box
  // （即父尺寸减去 border）解析，遵循 CSS §10.1。
  const paddingBoxW = parentWidth - bor[0] - bor[2]
  const paddingBoxH = parentHeight - bor[1] - bor[3]
  let cw = resolveValue(cs.width, paddingBoxW)
  let ch = resolveValue(cs.height, paddingBoxH)

  // 如果 left 与 right 都定义了，但 width 没定义，就反推出 width。
  if (!isDefined(cw) && isDefined(rLeft) && isDefined(rRight)) {
    cw = paddingBoxW - rLeft - rRight
  }
  if (!isDefined(ch) && isDefined(rTop) && isDefined(rBottom)) {
    ch = paddingBoxH - rTop - rBottom
  }

  layoutNode(
    child,
    cw,
    ch,
    isDefined(cw) ? MeasureMode.Exactly : MeasureMode.Undefined,
    isDefined(ch) ? MeasureMode.Exactly : MeasureMode.Undefined,
    paddingBoxW,
    paddingBoxH,
    true,
  )

  // 绝对定位子节点的 margin，会叠加在 insets 之外。
  const mL = resolveEdge(cs.margin, EDGE_LEFT, parentWidth)
  const mT = resolveEdge(cs.margin, EDGE_TOP, parentWidth)
  const mR = resolveEdge(cs.margin, EDGE_RIGHT, parentWidth)
  const mB = resolveEdge(cs.margin, EDGE_BOTTOM, parentWidth)

  const mainAxis = parent.style.flexDirection
  const reversed = isReverse(mainAxis)
  const mainRow = isRow(mainAxis)
  const wrapReverse = parent.style.flexWrap === Wrap.WrapReverse
  // 对绝对定位子节点而言，alignSelf 会像普通 flow item 一样覆盖 alignItems。
  const alignment =
    cs.alignSelf === Align.Auto ? parent.style.alignItems : cs.alignSelf

  // 计算位置。
  let left: number
  if (isDefined(rLeft)) {
    left = bor[0] + rLeft + mL
  } else if (isDefined(rRight)) {
    left = parentWidth - bor[2] - rRight - child.layout.width - mR
  } else if (mainRow) {
    // 主轴方向下使用 justify-content；若为 reversed，则取翻转后的结果。
    const lead = pad[0] + bor[0]
    const trail = parentWidth - pad[2] - bor[2]
    left = reversed
      ? trail - child.layout.width - mR
      : justifyAbsolute(
          parent.style.justifyContent,
          lead,
          trail,
          child.layout.width,
        ) + mL
  } else {
    left =
      alignAbsolute(
        alignment,
        pad[0] + bor[0],
        parentWidth - pad[2] - bor[2],
        child.layout.width,
        wrapReverse,
      ) + mL
  }

  let top: number
  if (isDefined(rTop)) {
    top = bor[1] + rTop + mT
  } else if (isDefined(rBottom)) {
    top = parentHeight - bor[3] - rBottom - child.layout.height - mB
  } else if (mainRow) {
    top =
      alignAbsolute(
        alignment,
        pad[1] + bor[1],
        parentHeight - pad[3] - bor[3],
        child.layout.height,
        wrapReverse,
      ) + mT
  } else {
    const lead = pad[1] + bor[1]
    const trail = parentHeight - pad[3] - bor[3]
    top = reversed
      ? trail - child.layout.height - mB
      : justifyAbsolute(
          parent.style.justifyContent,
          lead,
          trail,
          child.layout.height,
        ) + mT
  }

  child.layout.left = left
  child.layout.top = top
}

function justifyAbsolute(
  justify: Justify,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
): number {
  switch (justify) {
    case Justify.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2
    case Justify.FlexEnd:
      return trailEdge - childSize
    default:
      return leadEdge
  }
}

function alignAbsolute(
  align: Align,
  leadEdge: number,
  trailEdge: number,
  childSize: number,
  wrapReverse: boolean,
): number {
  // wrap-reverse 会翻转 cross axis：flex-start/stretch 落到 trailing，
  // flex-end 落到 leading。
  // 这与 yoga 的 absoluteLayoutChild 一致，会在 containing block
  // 为 wrap-reverse 时翻转对齐语义。
  switch (align) {
    case Align.Center:
      return leadEdge + (trailEdge - leadEdge - childSize) / 2
    case Align.FlexEnd:
      return wrapReverse ? leadEdge : trailEdge - childSize
    default:
      return wrapReverse ? trailEdge - childSize : leadEdge
  }
}

function computeFlexBasis(
  child: Node,
  mainAxis: FlexDirection,
  availableMain: number,
  availableCross: number,
  crossMode: MeasureMode,
  ownerWidth: number,
  ownerHeight: number,
): number {
  // 同一 generation 的缓存命中意味着 basis 就是在本轮 calculateLayout 中算出来的，
  // 因此不受 isDirty_ 影响，天然是新鲜的。
  // 这既覆盖干净子节点（滚动经过未变化消息），也覆盖刚挂载的脏子节点
  // （虚拟滚动中新项目挂载时，脏链的 measure→layout 级联会反复调用这里，
  // 但子树在同一轮 calculateLayout 内并不会变化）。
  // 对来自旧 generation 的干净缓存，只要输入匹配也可以命中；
  // 脏节点的旧缓存则会被 isDirty_ 拦住，因为那一定已过期。
  const sameGen = child._fbGen === _generation
  if (
    (sameGen || !child.isDirty_) &&
    child._fbCrossMode === crossMode &&
    sameFloat(child._fbOwnerW, ownerWidth) &&
    sameFloat(child._fbOwnerH, ownerHeight) &&
    sameFloat(child._fbAvailMain, availableMain) &&
    sameFloat(child._fbAvailCross, availableCross)
  ) {
    return child._fbBasis
  }
  const cs = child.style
  const isMainRow = isRow(mainAxis)

  // 显式声明的 flex-basis。
  const basis = resolveValue(cs.flexBasis, availableMain)
  if (isDefined(basis)) {
    const b = Math.max(0, basis)
    child._fbBasis = b
    child._fbOwnerW = ownerWidth
    child._fbOwnerH = ownerHeight
    child._fbAvailMain = availableMain
    child._fbAvailCross = availableCross
    child._fbCrossMode = crossMode
    child._fbGen = _generation
    return b
  }

  // 主轴上的 style dimension。
  const mainStyleDim = isMainRow ? cs.width : cs.height
  const mainOwner = isMainRow ? ownerWidth : ownerHeight
  const resolved = resolveValue(mainStyleDim, mainOwner)
  if (isDefined(resolved)) {
    const b = Math.max(0, resolved)
    child._fbBasis = b
    child._fbOwnerW = ownerWidth
    child._fbOwnerH = ownerHeight
    child._fbAvailMain = availableMain
    child._fbAvailCross = availableCross
    child._fbCrossMode = crossMode
    child._fbGen = _generation
    return b
  }

  // 需要通过测量子节点来获得其自然尺寸。
  const crossStyleDim = isMainRow ? cs.height : cs.width
  const crossOwner = isMainRow ? ownerHeight : ownerWidth
  let crossConstraint = resolveValue(crossStyleDim, crossOwner)
  let crossConstraintMode: MeasureMode = isDefined(crossConstraint)
    ? MeasureMode.Exactly
    : MeasureMode.Undefined
  if (!isDefined(crossConstraint) && isDefined(availableCross)) {
    crossConstraint = availableCross
    crossConstraintMode =
      crossMode === MeasureMode.Exactly && isStretchAlign(child)
        ? MeasureMode.Exactly
        : MeasureMode.AtMost
  }

  // 上游 yoga（YGNodeComputeFlexBasisForChild）在子树会调用 measure-func 时，
  // 会把可用 inner width 以 AtMost 模式传入。
  // 这样 text 节点就不会把“无约束 intrinsic width”误报成 flex-basis，
  // 从而避免兄弟节点被迫收缩、文本又在错误宽度下换行。
  // 如果这里传 Undefined，会导致 Ink 中 <Box flexGrow={1}> 里的 <Text>
  // 把宽度当成 intrinsic 而不是 available，最终在换行边界掉字。
  //
  // 该规则仅在以下条件下成立：
  //   - 只约束宽度，不约束高度。basis 测量阶段不能限制高度，
  //     否则 column 容器里的可滚动内容无法自然溢出。
  //   - 子树中确实存在 measure-func。纯布局子树如果也套用 AtMost，
  //     带 flex-grow 的子节点会沿着这个约束长大，错误抬高 basis。
  let mainConstraint = NaN
  let mainConstraintMode: MeasureMode = MeasureMode.Undefined
  if (isMainRow && isDefined(availableMain) && hasMeasureFuncInSubtree(child)) {
    mainConstraint = availableMain
    mainConstraintMode = MeasureMode.AtMost
  }

  const mw = isMainRow ? mainConstraint : crossConstraint
  const mh = isMainRow ? crossConstraint : mainConstraint
  const mwMode = isMainRow ? mainConstraintMode : crossConstraintMode
  const mhMode = isMainRow ? crossConstraintMode : mainConstraintMode

  layoutNode(child, mw, mh, mwMode, mhMode, ownerWidth, ownerHeight, false)
  const b = isMainRow ? child.layout.width : child.layout.height
  child._fbBasis = b
  child._fbOwnerW = ownerWidth
  child._fbOwnerH = ownerHeight
  child._fbAvailMain = availableMain
  child._fbAvailCross = availableCross
  child._fbCrossMode = crossMode
  child._fbGen = _generation
  return b
}

function hasMeasureFuncInSubtree(node: Node): boolean {
  if (node.measureFunc) return true
  for (const c of node.children) {
    if (hasMeasureFuncInSubtree(c)) return true
  }
  return false
}

function resolveFlexibleLengths(
  children: Node[],
  availableInnerMain: number,
  totalFlexBasis: number,
  isMainRow: boolean,
  ownerW: number,
  ownerH: number,
): void {
  // 按 CSS flexbox 规范 §9.7 “Resolving Flexible Lengths” 进行多轮 flex 分配：
  // 分发剩余空间、检测 min/max 违规、冻结违规项，再在未冻结子项之间重新分配，
  // 直到结果稳定为止。
  const n = children.length
  const frozen: boolean[] = new Array(n).fill(false)
  const initialFree = isDefined(availableInnerMain)
    ? availableInnerMain - totalFlexBasis
    : 0
  // 先把不具伸缩性的项冻结在钳制后的 basis 上。
  for (let i = 0; i < n; i++) {
    const c = children[i]!
    const clamped = boundAxis(c.style, isMainRow, c._flexBasis, ownerW, ownerH)
    const inflexible =
      !isDefined(availableInnerMain) ||
      (initialFree >= 0 ? c.style.flexGrow === 0 : c.style.flexShrink === 0)
    if (inflexible) {
      c._mainSize = Math.max(0, clamped)
      frozen[i] = true
    } else {
      c._mainSize = c._flexBasis
    }
  }
  // 迭代分配，直到不再出现违规。
  // 每轮都会重新计算 free space：初始 free space 减去被冻结子项相对其 basis
  // 多占用或少占用的那部分差值。
  const unclamped: number[] = new Array(n)
  for (let iter = 0; iter <= n; iter++) {
    let frozenDelta = 0
    let totalGrow = 0
    let totalShrinkScaled = 0
    let unfrozenCount = 0
    for (let i = 0; i < n; i++) {
      const c = children[i]!
      if (frozen[i]) {
        frozenDelta += c._mainSize - c._flexBasis
      } else {
        totalGrow += c.style.flexGrow
        totalShrinkScaled += c.style.flexShrink * c._flexBasis
        unfrozenCount++
      }
    }
    if (unfrozenCount === 0) break
    let remaining = initialFree - frozenDelta
    // 规范 §9.7 step 4c：如果 flex factor 总和小于 1，
    // 只分配 initialFree × sum，而不是全部 remaining space。
    if (remaining > 0 && totalGrow > 0 && totalGrow < 1) {
      const scaled = initialFree * totalGrow
      if (scaled < remaining) remaining = scaled
    } else if (remaining < 0 && totalShrinkScaled > 0) {
      let totalShrink = 0
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) totalShrink += children[i]!.style.flexShrink
      }
      if (totalShrink < 1) {
        const scaled = initialFree * totalShrink
        if (scaled > remaining) remaining = scaled
      }
    }
    // 为所有未冻结子项计算目标尺寸与违规量。
    let totalViolation = 0
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue
      const c = children[i]!
      let t = c._flexBasis
      if (remaining > 0 && totalGrow > 0) {
        t += (remaining * c.style.flexGrow) / totalGrow
      } else if (remaining < 0 && totalShrinkScaled > 0) {
        t +=
          (remaining * (c.style.flexShrink * c._flexBasis)) / totalShrinkScaled
      }
      unclamped[i] = t
      const clamped = Math.max(
        0,
        boundAxis(c.style, isMainRow, t, ownerW, ownerH),
      )
      c._mainSize = clamped
      totalViolation += clamped - t
    }
    // 按规范 §9.7 step 5 冻结：
    // totalViolation 为 0 时全部冻结；为正时冻结 min-violator；
    // 为负时冻结 max-violator。
    if (totalViolation === 0) break
    let anyFrozen = false
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue
      const v = children[i]!._mainSize - unclamped[i]!
      if ((totalViolation > 0 && v > 0) || (totalViolation < 0 && v < 0)) {
        frozen[i] = true
        anyFrozen = true
      }
    }
    if (!anyFrozen) break
  }
}

function isStretchAlign(child: Node): boolean {
  const p = child.parent
  if (!p) return false
  const align =
    child.style.alignSelf === Align.Auto
      ? p.style.alignItems
      : child.style.alignSelf
  return align === Align.Stretch
}

function resolveChildAlign(parent: Node, child: Node): Align {
  return child.style.alignSelf === Align.Auto
    ? parent.style.alignItems
    : child.style.alignSelf
}

// 按 CSS Flexbox §8.5 / yoga 的 YGBaseline 计算节点 baseline。
// 叶子节点（无子节点）直接使用自身高度；容器节点则递归进入第一行中
// 第一个 baseline 对齐的子节点（若没有则取第一个 flow child），
// 返回其 baseline 与 top offset 之和。
function calculateBaseline(node: Node): number {
  let baselineChild: Node | null = null
  for (const c of node.children) {
    if (c._lineIndex > 0) break
    if (c.style.positionType === PositionType.Absolute) continue
    if (c.style.display === Display.None) continue
    if (
      resolveChildAlign(node, c) === Align.Baseline ||
      c.isReferenceBaseline_
    ) {
      baselineChild = c
      break
    }
    if (baselineChild === null) baselineChild = c
  }
  if (baselineChild === null) return node.layout.height
  return calculateBaseline(baselineChild) + baselineChild.layout.top
}

// 容器只会在 row 方向下启用 baseline 布局，且前提是：
// 要么 align-items 为 baseline，要么存在 flow child 的 align-self 为 baseline。
function isBaselineLayout(node: Node, flowChildren: Node[]): boolean {
  if (!isRow(node.style.flexDirection)) return false
  if (node.style.alignItems === Align.Baseline) return true
  for (const c of flowChildren) {
    if (c.style.alignSelf === Align.Baseline) return true
  }
  return false
}

function childMarginForAxis(
  child: Node,
  axis: FlexDirection,
  ownerWidth: number,
): number {
  if (!child._hasMargin) return 0
  const lead = resolveEdge(child.style.margin, leadingEdge(axis), ownerWidth)
  const trail = resolveEdge(child.style.margin, trailingEdge(axis), ownerWidth)
  return lead + trail
}

function resolveGap(style: Style, gutter: Gutter, ownerSize: number): number {
  let v = style.gap[gutter]!
  if (v.unit === Unit.Undefined) v = style.gap[Gutter.All]!
  const r = resolveValue(v, ownerSize)
  return isDefined(r) ? Math.max(0, r) : 0
}

function boundAxis(
  style: Style,
  isWidth: boolean,
  value: number,
  ownerWidth: number,
  ownerHeight: number,
): number {
  const minV = isWidth ? style.minWidth : style.minHeight
  const maxV = isWidth ? style.maxWidth : style.maxHeight
  const minU = minV.unit
  const maxU = maxV.unit
  // 快路径：没有设置 min/max 约束。
  // 从 CPU profile 看，这是绝对主流场景，因此跳过那几次注定 no-op 的
  // resolveValue 与 isNaN 检查是值得的。Unit.Undefined = 0。
  if (minU === 0 && maxU === 0) return value
  const owner = isWidth ? ownerWidth : ownerHeight
  let v = value
  // 内联版 resolveValue：Unit.Point=1，Unit.Percent=2。`m === m` 等价于 !isNaN。
  if (maxU === 1) {
    if (v > maxV.value) v = maxV.value
  } else if (maxU === 2) {
    const m = (maxV.value * owner) / 100
    if (m === m && v > m) v = m
  }
  if (minU === 1) {
    if (v < minV.value) v = minV.value
  } else if (minU === 2) {
    const m = (minV.value * owner) / 100
    if (m === m && v < m) v = m
  }
  return v
}

function zeroLayoutRecursive(node: Node): void {
  for (const c of node.children) {
    c.layout.left = 0
    c.layout.top = 0
    c.layout.width = 0
    c.layout.height = 0
    // 让 layout cache 失效。
    // 否则 unhide 后再 calculateLayout，会把子节点误判为干净节点并命中旧缓存，
    // 直接提前返回，跳过对子孙节点的位置递归，最终让它们停留在 (0,0,0,0)。
    // 同时把 isDirty_ 设为 true 还能阻止 _cN 与 _fbBasis 走
    // (sameGen || !isDirty_) 这条命中路径。
    c.isDirty_ = true
    c._hasL = false
    c._hasM = false
    zeroLayoutRecursive(c)
  }
}

function collectLayoutChildren(node: Node, flow: Node[], abs: Node[]): void {
  // 把节点的子节点划分到 flow 与 absolute 列表中，
  // 同时展开 display:contents 子树，使其孩子直接作为当前节点的布局孩子。
  for (const c of node.children) {
    const disp = c.style.display
    if (disp === Display.None) {
      c.layout.left = 0
      c.layout.top = 0
      c.layout.width = 0
      c.layout.height = 0
      zeroLayoutRecursive(c)
    } else if (disp === Display.Contents) {
      c.layout.left = 0
      c.layout.top = 0
      c.layout.width = 0
      c.layout.height = 0
      // 继续递归展开。嵌套的 display:contents 会一路向上提升，
      // 而 contents 节点自己的 margin/padding/position/dimensions 会被忽略。
      collectLayoutChildren(c, flow, abs)
    } else if (c.style.positionType === PositionType.Absolute) {
      abs.push(c)
    } else {
      flow.push(c)
    }
  }
}

function roundLayout(
  node: Node,
  scale: number,
  absLeft: number,
  absTop: number,
): void {
  if (scale === 0) return
  const l = node.layout
  const nodeLeft = l.left
  const nodeTop = l.top
  const nodeWidth = l.width
  const nodeHeight = l.height

  const absNodeLeft = absLeft + nodeLeft
  const absNodeTop = absTop + nodeTop

  // 对齐上游 YGRoundValueToPixelGrid：文本节点（带 measureFunc）会对位置取 floor，
  // 避免换行文本跑到分配列之外；宽度则在有小数时取 ceil，避免裁掉最后一个字形。
  // 非文本节点仍用普通 round。若不这样做，justify center/space-evenly 的位置
  // 会相对 WASM 出现 off-by-one，flex-shrink 溢出时兄弟节点也会落错列。
  const isText = node.measureFunc !== null
  l.left = roundValue(nodeLeft, scale, false, isText)
  l.top = roundValue(nodeTop, scale, false, isText)

  // 通过绝对边来计算 width/height 的舍入，避免累计漂移。
  const absRight = absNodeLeft + nodeWidth
  const absBottom = absNodeTop + nodeHeight
  const hasFracW = !isWholeNumber(nodeWidth * scale)
  const hasFracH = !isWholeNumber(nodeHeight * scale)
  l.width =
    roundValue(absRight, scale, isText && hasFracW, isText && !hasFracW) -
    roundValue(absNodeLeft, scale, false, isText)
  l.height =
    roundValue(absBottom, scale, isText && hasFracH, isText && !hasFracH) -
    roundValue(absNodeTop, scale, false, isText)

  for (const c of node.children) {
    roundLayout(c, scale, absNodeLeft, absNodeTop)
  }
}

function isWholeNumber(v: number): boolean {
  const frac = v - Math.floor(v)
  return frac < 0.0001 || frac > 0.9999
}

function roundValue(
  v: number,
  scale: number,
  forceCeil: boolean,
  forceFloor: boolean,
): number {
  let scaled = v * scale
  let frac = scaled - Math.floor(scaled)
  if (frac < 0) frac += 1
  // 浮点 epsilon 容忍度与上游 YGDoubleEqual 保持一致（1e-4）。
  if (frac < 0.0001) {
    scaled = Math.floor(scaled)
  } else if (frac > 0.9999) {
    scaled = Math.ceil(scaled)
  } else if (forceCeil) {
    scaled = Math.ceil(scaled)
  } else if (forceFloor) {
    scaled = Math.floor(scaled)
  } else {
    // 按上游行为做 half-up 四舍五入（>= 0.5 就进位）。
    scaled = Math.floor(scaled) + (frac >= 0.4999 ? 1 : 0)
  }
  return scaled / scale
}

// --
// 辅助函数

function parseDimension(v: number | string | undefined): Value {
  if (v === undefined) return UNDEFINED_VALUE
  if (v === 'auto') return AUTO_VALUE
  if (typeof v === 'number') {
    // WASM yoga 的 YGFloatIsUndefined 会把 NaN 与 ±Infinity 都视为 undefined。
    // Ink 会传入 height={Infinity}（例如 LogSelector 的默认 maxHeight），
    // 并期望它表示“无约束”；如果把它当成普通 point 值存下来，
    // 节点高度就会变成 Infinity，并破坏后续所有布局计算。
    return Number.isFinite(v) ? pointValue(v) : UNDEFINED_VALUE
  }
  if (typeof v === 'string' && v.endsWith('%')) {
    return percentValue(parseFloat(v))
  }
  const n = parseFloat(v)
  return isNaN(n) ? UNDEFINED_VALUE : pointValue(n)
}

function physicalEdge(edge: Edge): number {
  switch (edge) {
    case Edge.Left:
    case Edge.Start:
      return EDGE_LEFT
    case Edge.Top:
      return EDGE_TOP
    case Edge.Right:
    case Edge.End:
      return EDGE_RIGHT
    case Edge.Bottom:
      return EDGE_BOTTOM
    default:
      return EDGE_LEFT
  }
}

// --
// 与 yoga-layout/load 对齐的模块 API

export type Yoga = {
  Config: {
    create(): Config
    destroy(config: Config): void
  }
  Node: {
    create(config?: Config): Node
    createDefault(): Node
    createWithConfig(config: Config): Node
    destroy(node: Node): void
  }
}

const YOGA_INSTANCE: Yoga = {
  Config: {
    create: createConfig,
    destroy() {},
  },
  Node: {
    create: (config?: Config) => new Node(config),
    createDefault: () => new Node(),
    createWithConfig: (config: Config) => new Node(config),
    destroy() {},
  },
}

export function loadYoga(): Promise<Yoga> {
  return Promise.resolve(YOGA_INSTANCE)
}

export default YOGA_INSTANCE
