import type { RefObject } from 'react'
import {
  useCallback,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'

/**
 * 尚未测量项目的估算高度（行数）。这里故意取偏低：
 * 高估会带来空白区域（我们会过早停止挂载，视口底部只剩空 spacer），
 * 而低估只会让多挂载少量 overscan 项。这种不对称意味着宁可偏低。
 */
const DEFAULT_ESTIMATE = 3
/**
 * 在视口上下额外渲染的行数。这里取值偏大，因为长 tool result 的真实高度
 * 可能达到估算值的 10 倍。
 */
const OVERSCAN_ROWS = 80
/** ScrollBox 尚未完成布局（viewportHeight=0）前先渲染的项目数。 */
const COLD_START_COUNT = 30
/**
 * 用于 useSyncExternalStore snapshot 的 scrollTop 量化。如果不做这层量化，
 * 每个滚轮 tick（每档 3 到 5 次）都会触发一次完整的 React commit +
 * Yoga calculateLayout() + Ink diff 周期，导致 CPU 飙升。视觉滚动本身仍然平滑：
 * ScrollBox.forceRender 会在每次 scrollBy 时触发，而 Ink 读取的是 DOM 节点里的
 * 真实 scrollTop，与 React 认为的值无关。React 只需要在挂载区间必须移动时重渲染；
 * OVERSCAN_ROWS 一半是最紧凑且安全的分箱粒度（保证在需要新 range 前，
 * 至少还剩 40 行 overscan）。
 */
const SCROLL_QUANTUM = OVERSCAN_ROWS >> 1
/**
 * 计算覆盖范围时，对未测量项目采用的最坏情况高度。
 * MessageRow 最小可以只有 1 行（单行 tool call）。这里使用 1 可保证
 * 无论项目实际有多矮，挂载区间在物理上都能覆盖到视口底部；
 * 代价是在项目较高时会多挂载一些内容，但这正好由 overscan 吸收。
 */
const PESSIMISTIC_HEIGHT = 1
/** 对挂载项数量设上限，即使在退化场景下也能限制 fiber 分配。 */
const MAX_MOUNTED_ITEMS = 300
/**
 * 单次 commit 允许新增挂载的最大项目数。若用 PESSIMISTIC_HEIGHT=1 滚入一个全新 range，
 * 一次可能挂上 194 个项目（OVERSCAN_ROWS*2 + viewportH = 194）；
 * 每个新 MessageRow 渲染约需 1.5ms（marked lexer + formatToken + 约 11 次 createInstance），
 * 总共会形成约 290ms 的同步阻塞。把 range 分多次逐步滑向目标位置，
 * 就能把每次 commit 的挂载成本限制住。渲染时的 clamp（scrollClampMin/Max）会把视口
 * 固定在已挂载内容的边缘，因此追赶过程中不会出现空白。
 */
const SLIDE_STEP = 25

const NOOP_UNSUB = () => {}

export type VirtualScrollResult = {
  /** 要渲染项目的半开区间 [startIndex, endIndex)。 */
  range: readonly [number, number]
  /** 第一个已渲染项目之前 spacer 的高度（行数）。 */
  topSpacer: number
  /** 最后一个已渲染项目之后 spacer 的高度（行数）。 */
  bottomSpacer: number
  /**
   * 回调 ref 工厂。把 `measureRef(itemKey)` 挂到每个已渲染项目的根 Box 上；
   * 在 Yoga 布局完成后，会缓存其计算得到的高度。
   */
  measureRef: (key: string) => (el: DOMElement | null) => void
  /**
   * 挂到 topSpacer Box 上。它的 Yoga computedTop 就是 listOrigin
   * （它是虚拟化区域的第一个子节点，因此它的 top = ScrollBox 中列表前面
   * 所有已渲染内容的累计高度）。
   * 这样不会产生漂移：无需从 offsets 中反推，也不依赖会在多次渲染间变化的
   * item 高度（例如 tmux resize）。
   */
  spacerRef: RefObject<DOMElement | null>
  /**
   * 每个项目在 list-wrapper 坐标系中的累计 y 偏移（不是 scrollbox 坐标，
   * 因为列表前面的 logo/兄弟节点会平移原点）。
   * offsets[i] = 项目 i 上方的行数；offsets[n] = totalHeight。
   * 每次渲染都会重算，不要按引用做 memo。
   */
  offsets: ArrayLike<number>
  /**
   * 读取指定索引项目的 Yoga computedTop。如果项目未挂载或尚未完成布局，则返回 -1。
   * item Box 是 ScrollBox 内容 wrapper 的直接 Yoga 子节点（fragment 在 Ink DOM 中会折叠），
   * 因此这里得到的是相对于 content-wrapper 的坐标，
   * 与 scrollTop 处于同一坐标空间。Yoga 布局与滚动无关（平移发生在后续 renderNodeToOutput 中），
   * 因此这些位置在滚动过程中依然有效，无需等待 Ink 重新渲染。
   * StickyTracker 会据此以每个滚动 tick 的粒度遍历挂载区间并找出视口边界，
   * 这比本 hook 的 40 行量化重渲染更细。
   */
  getItemTop: (index: number) => number
  /**
   * 获取指定索引项目已挂载的 DOMElement，没有则返回 null。
   * 供 ScrollBox.scrollToElement 使用，按元素 ref 锚定会把 Yoga 位置读取延后到渲染时，
   * 因此结果是确定性的，不会出现节流竞争。
   */
  getItemElement: (index: number) => DOMElement | null
  /** 已测得的 Yoga 高度。undefined 表示尚未测量；0 表示渲染结果为空。 */
  getItemHeight: (index: number) => number | undefined
  /**
   * 滚动，使项目 `i` 进入已挂载区间。具体会设置 scrollTop =
   * offsets[i] + listOrigin。range 逻辑会通过
   * scrollTop 与 offsets[] 来确定 start，二者都使用同一份 offsets 值，
   * 因此无论 offsets[i] 是否是真实位置，它们在构造上都保持一致。
   * 这样项目 i 一定会挂载；它在屏幕上的位置可能会因估算漂移而偏差几十行，
   * 但它已经在 DOM 中了。之后再调用 getItemTop(i) 获取精确位置即可。
   */
  scrollToIndex: (i: number) => void
}

/**
 * ScrollBox 内项目的 React 层虚拟化。
 *
 * ScrollBox 本身已经做了 Ink 输出层面的视口裁剪
 * （render-node-to-output.ts:617 会跳过可视窗口外的子节点），
 * 但所有 React fiber 和 Yoga node 仍然会被分配。按每个 MessageRow 约 250 KB RSS 估算，
 * 一个 1000 条消息的会话会消耗约 250 MB 只增不减的内存
 * （Ink 屏幕缓冲、WASM 线性内存、JSC 页面保留都只增不减）。
 *
 * 本 hook 只挂载视口内以及 overscan 范围内的项目。其余部分通过 spacer box 以 O(1) 的 fiber 成本
 * 维持滚动高度不变。
 *
 * 高度估算：未测量项目使用固定的 DEFAULT_ESTIMATE，首轮布局后再替换为真实 Yoga 高度。
 * 不做滚动锚定，估算误差由 overscan 吸收。如果实践中漂移明显，后续再加锚定
 * （topSpacer 变化时 scrollBy(delta)）也比较直接。
 *
 * stickyScroll 的一个注意点：render-node-to-output.ts:450 会在 Ink 的渲染阶段
 * 设置 scrollTop=maxScroll，但这不会触发 ScrollBox.subscribe。下面的
 * at-bottom 检查会兜住这个场景：当列表固定在底部时，我们无论 scrollTop 看起来如何
 * 都会渲染最后 N 个项目。
 */
export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  itemKeys: readonly string[],
  /**
   * 终端列数。变化时，缓存高度就会失效（文本会重新换行），这里不是直接清空，
   * 而是按 oldCols/newCols 比例缩放。若直接清空，悲观覆盖回溯会一次挂上约 190 个项目
   * （每个未缓存项目都按 PESSIMISTIC_HEIGHT=1 计算，需要回溯 190 个才能覆盖
   * viewport+2×overscan）。每个新挂载项目都要执行 marked.lexer + 语法高亮，
   * 单次约 3ms；长会话第一次 resize 时 React reconcile 可达约 600ms。
   * 缩放后 heightCache 仍然保留内容，回溯会使用“近似真实”的高度，
   * 挂载区间因此保持紧凑。缩放后的估算值会在下一次 useLayoutEffect 中被真实 Yoga 高度覆盖。
   *
   * 这些缩放值已经足够接近，因此不会触发扩大宽度时黑屏的 bug：
   * 旧 offsets 在 resize 前被高估，超过 resize 后的 scrollTop，导致 end
   * 循环停在尾部之前。宽度变大时 ratio<1，会把高度向下缩放，
   * 从而让 offsets 与 resize 后的 Yoga 结果保持大致对齐。
   */
  columns: number,
): VirtualScrollResult {
  const heightCache = useRef(new Map<string, number>())
  // 每次 heightCache 变动时递增版本号，这样 offsets 会在下次读取时重建。
  // 使用 ref（而不是 state），在渲染阶段直接检查，不会额外触发 commit。
  const offsetVersionRef = useRef(0)
  // 上一次 commit 时的 scrollTop，用于检测快速滚动模式（slide cap 的门槛条件）。
  const lastScrollTopRef = useRef(0)
  const offsetsRef = useRef<{ arr: Float64Array; version: number; n: number }>({
    arr: new Float64Array(0),
    version: -1,
    n: -1,
  })
  const itemRefs = useRef(new Map<string, DOMElement>())
  const refCache = useRef(new Map<string, (el: DOMElement | null) => void>())
  // 内联的 ref 比较必须在下面计算 offsets 之前完成。skip-flag 用来阻止
  // useLayoutEffect 用 resize 前的 Yoga 高度重新填充 heightCache
  // （useLayoutEffect 读取的是“本次渲染的 calculateLayout 之前那一帧”的 Yoga，
  // 也就是仍然使用旧宽度的那一帧）。下一次渲染中的 useLayoutEffect
  // 才会读到 resize 后的 Yoga，这时才是正确值。
  const prevColumns = useRef(columns)
  const skipMeasurementRef = useRef(false)
  // 在 resize 稳定周期内冻结挂载区间。已经挂载的项目有热 useMemo
  // （marked.lexer、高亮等），若根据缩放或悲观估算去重算 range，
  // 会导致 mount/unmount 抖动（每个新挂载约 3ms，合起来会形成约 150ms 的第二次闪烁）。
  // resize 前的 range 已经足够合理，旧宽度下用户看到的项目，也正是新宽度下最希望先看到的内容。
  // 冻结 2 次渲染：第 1 次渲染启用 skipMeasurement（Yoga 仍是 resize 前的），
  // 第 2 次渲染的 useLayoutEffect 会把 resize 后的 Yoga 读入 heightCache。
  // 到第 3 次渲染，高度已准确，恢复正常重算。
  const prevRangeRef = useRef<readonly [number, number] | null>(null)
  const freezeRendersRef = useRef(0)
  if (prevColumns.current !== columns) {
    const ratio = prevColumns.current / columns
    prevColumns.current = columns
    for (const [k, h] of heightCache.current) {
      heightCache.current.set(k, Math.max(1, Math.round(h * ratio)))
    }
    offsetVersionRef.current++
    skipMeasurementRef.current = true
    freezeRendersRef.current = 2
  }
  const frozenRange = freezeRendersRef.current > 0 ? prevRangeRef.current : null
  // 列表原点，使用 content-wrapper 坐标。scrollTop 是相对于 content-wrapper 的，
  // 但 offsets[] 是列表局部坐标（0 表示第一个虚拟化项目）。
  // 那些在 ScrollBox 里、且渲染在列表之前的兄弟节点，如 Logo、
  // StatusNotices、Messages.tsx 里的 truncation divider，会按它们的累计高度
  // 平移 item 的 Yoga 位置。如果不减掉这部分，非 sticky 分支里的 effLo/effHi 会被放大，
  // start 会越过其实仍在视口内的项目（当 sticky 失效且 scrollTop 接近最大值时，
  // 点击/滚动会出现空白视口）。这里直接读取 topSpacer 的 Yoga computedTop，
  // 因为它就是虚拟化区域的第一个子节点，所以它的 top 就是 listOrigin。
  // 不再从 offsets 做反推，也就不会在项目高度跨渲染变化时产生漂移
  // （例如 tmux resize：列数变化 → 重新换行 → 高度收缩 → 旧的样本减法变成负值 →
  // effLo 被抬高 → 黑屏）。它和 heightCache 一样存在一帧延迟。
  const listOriginRef = useRef(0)
  const spacerRef = useRef<DOMElement | null>(null)

  // useSyncExternalStore 把重新渲染与命令式滚动绑定起来。snapshot 中的
  // scrollTop 会被量化到 SCROLL_QUANTUM 的分箱里，因此对于小幅滚动
  // （大多数滚轮 tick），Object.is 看不到变化，React 就会跳过 commit + Yoga
  // + Ink 整个周期，直到累计位移跨过一个分箱。
  // sticky 状态也被折进了 snapshot（通过符号位），因此 sticky→broken
  // 也会触发更新：scrollToBottom 会把 sticky 设为 true，却不会立即改变 scrollTop
  // （Ink 稍后才会移动它），而之后第一次 scrollBy 可能仍然落在同一个分箱中。
  // NaN 哨兵表示 ref 还没挂上。
  const subscribe = useCallback(
    (listener: () => void) =>
      scrollRef.current?.subscribe(listener) ?? NOOP_UNSUB,
    [scrollRef],
  )
  useSyncExternalStore(subscribe, () => {
    const s = scrollRef.current
    if (!s) return NaN
    // Snapshot 使用的是目标值（scrollTop + pendingDelta），而不是已提交的
    // scrollTop。scrollBy 只会修改 pendingDelta（渲染器会在多帧中慢慢消耗它），
    // 已提交的 scrollTop 会滞后。使用 target 意味着
    // scrollBy 触发 notify() 时 snapshot 真的会变化，从而 React 能在 Ink 的排空帧需要它们之前
    // 先把目标位置对应的 children 挂上。
    const target = s.getScrollTop() + s.getPendingDelta()
    const bin = Math.floor(target / SCROLL_QUANTUM)
    return s.isSticky() ? ~bin : bin
  })
  // 读取真实的已提交 scrollTop（不做量化）来计算 range。
  // 量化只是重渲染门槛，不是位置值本身。
  const scrollTop = scrollRef.current?.getScrollTop() ?? -1
  // Range 必须同时覆盖已提交的 scrollTop（Ink 当前正在渲染的位置）
  // 和 target（pending 最终会被排空到的位置）。在排空过程中，中间帧的 scrollTop
  // 会落在两者之间；如果我们只按 target 挂载，这些中间帧就会找不到 child，
  // 只剩空白行。
  const pendingDelta = scrollRef.current?.getPendingDelta() ?? 0
  const viewportH = scrollRef.current?.getViewportHeight() ?? 0
  // true 表示 ScrollBox 被固定在底部。这是唯一稳定的“已在底部”信号：
  // scrollTop/scrollHeight 都反映的是上一次渲染的布局，
  // 而上一次布局又依赖于“我们渲染了什么”（topSpacer + items），
  // 从而形成反馈环（range → layout → atBottom → range）。
  // stickyScroll 可能由用户操作（scrollToBottom/scrollBy）、初始属性，
  // 以及 render-node-to-output 中的位置跟随逻辑设置
  // （scrollTop>=prevMax → 钉到新的 max → 设置标记）。渲染器的这次写入是
  // 这在反馈层面是安全的：它只会从 false 变成 true，而且只会在已经位于
  // 位置意义上的底部时发生。这里 flag 为 true 只表示“从尾部回走、
  // 清除 clamp”，行为上等同于直接读取 scrollTop==maxScroll，
  // 但没有那种不稳定性。默认值为 true：在 ref 挂载前，
  // 先假定处于底部（第一次 Ink 渲染时 sticky 会把它钉住）。
  const isSticky = scrollRef.current?.isSticky() ?? true

  // 清理过期缓存项（compaction、/clear、screenToggleId 变化时）。只有在
  // itemKeys 引用变化时才会执行，滚动不会触碰 keys。
  // itemRefs 会在卸载时通过 ref(null) 自行清理。
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
  useMemo(() => {
    const live = new Set(itemKeys)
    let dirty = false
    for (const k of heightCache.current.keys()) {
      if (!live.has(k)) {
        heightCache.current.delete(k)
        dirty = true
      }
    }
    for (const k of refCache.current.keys()) {
      if (!live.has(k)) refCache.current.delete(k)
    }
    if (dirty) offsetVersionRef.current++
  }, [itemKeys])

  // offsets 在多次渲染间缓存，并通过 offsetVersion 的 ref 递增来失效。
  // 之前的做法是每次渲染都分配一个新的 Array(n+1)，并执行 n 次 Map.get；
  // 当 n≈27k 且处于按键连发滚动速率（约 11 次 commit/秒）时，
  // 相当于每秒约 30 万次查找，还伴随新数组分配，最终造成 GC 抖动和约 2ms/次渲染的开销。
  // version 由 heightCache 的写入方递增（measureRef、resize-scale、GC）。
  // 不使用 setState，重建通过渲染期的 ref 版本检查按需完成，
  // 属于读取侧懒执行（同一次 commit，不会额外调度）。
  // 之前迫使我们内联重算的闪烁问题，正是 setState 驱动失效造成的。
  const n = itemKeys.length
  if (
    offsetsRef.current.version !== offsetVersionRef.current ||
    offsetsRef.current.n !== n
  ) {
    const arr =
      offsetsRef.current.arr.length >= n + 1
        ? offsetsRef.current.arr
        : new Float64Array(n + 1)
    arr[0] = 0
    for (let i = 0; i < n; i++) {
      arr[i + 1] =
        arr[i]! + (heightCache.current.get(itemKeys[i]!) ?? DEFAULT_ESTIMATE)
    }
    offsetsRef.current = { arr, version: offsetVersionRef.current, n }
  }
  const offsets = offsetsRef.current.arr
  const totalHeight = offsets[n]!

  let start: number
  let end: number

  if (frozenRange) {
    // 列数刚刚发生变化。保留 resize 前的 range，避免 mount churn。
    // 若消息被移除了（/clear、compaction），则把边界钳到 n。
    ;[start, end] = frozenRange
    start = Math.min(start, n)
    end = Math.min(end, n)
  } else if (viewportH === 0 || scrollTop < 0) {
    // 冷启动：ScrollBox 尚未完成布局。先渲染尾部，因为 sticky
    // scroll 会在第一次 Ink 渲染时把列表固定到底部，这些正是用户真正会看到的项目。
    // 之后如果用户向上滚动，就会经过
    // scrollBy → subscribe 触发 → 我们再用真实值重渲染。
    start = Math.max(0, n - COLD_START_COUNT)
    end = n
  } else {
    if (isSticky) {
      // sticky-scroll 的兜底路径。render-node-to-output 可能已经移动了 scrollTop，
      // 却没有通知到我们，因此这里更相信“已在底部”这一状态，而不是过期 snapshot。
      // 从尾部向前回走，直到覆盖 viewport + overscan。
      const budget = viewportH + OVERSCAN_ROWS
      start = n
      while (start > 0 && totalHeight - offsets[start - 1]! < budget) {
        start--
      }
      end = n
    } else {
      // 用户已经向上滚动。先从 offsets 计算 start（基于估算：
      // 即使略有低估也没关系，最多只是早点开始挂载）。
      // 然后用“累计的当前最佳已知高度”来扩展 end，而不是依赖估算 offsets。
      // 这里要维持的约束是：
      //   topSpacer + sum(real_heights[start..end]) >= scrollTop + viewportH + overscan
      // 由于 topSpacer = offsets[start] ≤ scrollTop - overscan，因此需要：
      //   sum(real_heights) >= viewportH + 2*overscan
      // 对未测量项目，使用 PESSIMISTIC_HEIGHT=1，也就是 MessageRow 的最小可能高度。
      // 这样在项目很高时会多挂载一些，但在快速穿越未测量区域滚动时，
      // 永远不会让视口只剩空 spacer。等高度被缓存后（下一次渲染），
      // 覆盖范围就会改用真实值计算，range 也会收紧。
      // 只有当 item K 可以安全并入 topSpacer 且不会产生可见跳变时，
      // 才允许让 start 越过它。安全情况有两类：
      //   (a) K 当前没有挂载（itemRefs 中不存在）。它对 offsets 的贡献
      //       始终就是估算值，因此 spacer 已经和原先显示一致，不会改变布局。
      //   (b) K 已经挂载且高度已缓存。offsets[start+1] 使用的是
      //       真实高度，因此 topSpacer = offsets[start+1] 会与 K 所占的 Yoga 区间
      //       完全一致，可无缝卸载。
      // 不安全的情况是：K 已经挂载但还没缓存高度，也就是 mount 到
      // useLayoutEffect 测量之间的那一帧窗口。让 K 再多挂一帧，
      // 测量才能落地。
      // 挂载区间需要覆盖 [committed, target]，这样每一帧 drain 都有内容可显示。
      // 同时要把下界钳到 0：激进的滚轮上滑会让 pendingDelta
      // 远远越过 0（例如 MX Master 的自由滚动），但 scrollTop 本身永远不会为负。
      // 如果不钳制，effLo 会把 start 一路拖到 0，而 effHi 还停留在当前较高的 scrollTop，
      // 覆盖区间会超过 MAX_MOUNTED_ITEMS 能承载的范围，最终让早期 drain 帧出现空白。
      // listOrigin 会先把 scrollTop（content-wrapper 坐标）转换成
      // 列表局部坐标，再与 offsets[] 比较。否则，列表前的兄弟节点
      // （Messages.tsx 中的 Logo+notices）会把 scrollTop 按自身高度抬高，
      // 导致 start 过度前进，先吃掉 overscan，再在抬高幅度超过 OVERSCAN_ROWS 后
      // 吃掉真实可见行。
      const listOrigin = listOriginRef.current
      // 限制 [committed..target] 这段跨度。当输入速度超过渲染速度时，
      // pendingDelta 会无限增长，effLo..effHi 可能覆盖数百个未挂载行，
      // 结果是一次 commit 要挂上 194 个全新 MessageRow，形成 3 秒以上的
      // 同步阻塞，随后又有更多输入排队，下次 delta 更大，进入死亡螺旋。
      // 限制跨度就能限制每次 commit 的新挂载量；而 clamp（setClampBounds）会在追赶过程中
      // 显示已挂载内容的边缘，因此不会黑屏，只是让滚动在几帧内逐步到达目标，
      // 而不是一次冻结好几秒。
      const MAX_SPAN_ROWS = viewportH * 3
      const rawLo = Math.min(scrollTop, scrollTop + pendingDelta)
      const rawHi = Math.max(scrollTop, scrollTop + pendingDelta)
      const span = rawHi - rawLo
      const clampedLo =
        span > MAX_SPAN_ROWS
          ? pendingDelta < 0
            ? rawHi - MAX_SPAN_ROWS // 向上滚动：靠近目标位置（低端）
            : rawLo // 向下滚动：靠近已提交位置
          : rawLo
      const clampedHi = clampedLo + Math.min(span, MAX_SPAN_ROWS)
      const effLo = Math.max(0, clampedLo - listOrigin)
      const effHi = clampedHi - listOrigin
      const lo = effLo - OVERSCAN_ROWS
      // 用二分搜索 start，因为 offsets 是单调递增的。之前线性的 while(start++)
      // 在 27k 消息会话中（从底部向上滚，start≈27200）每次渲染都要跑约 27k 次。
      // 现在是 O(log n)。
      {
        let l = 0
        let r = n
        while (l < r) {
          const m = (l + r) >> 1
          if (offsets[m + 1]! <= lo) l = m + 1
          else r = m
        }
        start = l
      }
      // 保护逻辑：不要越过那些“已挂载但尚未测量”的项目。在 mount 到
      // useLayoutEffect 测量之间的那一帧里，如果卸载这些项目，topSpacer 会退回到
      // DEFAULT_ESTIMATE，而这与它们未知的真实跨度不一致，从而产生闪烁。
      // 已挂载项目位于 [prevStart, prevEnd)；只扫描这段，而不是全量 n。
      {
        const p = prevRangeRef.current
        if (p && p[0] < start) {
          for (let i = p[0]; i < Math.min(start, p[1]); i++) {
            const k = itemKeys[i]!
            if (itemRefs.current.has(k) && !heightCache.current.has(k)) {
              start = i
              break
            }
          }
        }
      }

      const needed = viewportH + 2 * OVERSCAN_ROWS
      const maxEnd = Math.min(n, start + MAX_MOUNTED_ITEMS)
      let coverage = 0
      end = start
      while (
        end < maxEnd &&
        (coverage < needed || offsets[end]! < effHi + viewportH + OVERSCAN_ROWS)
      ) {
        coverage +=
          heightCache.current.get(itemKeys[end]!) ?? PESSIMISTIC_HEIGHT
        end++
      }
    }
    // atBottom 路径也需要同样的覆盖保证
    // （它之前按估算 offsets 回退 start，若项目很矮就可能低估）。
    const needed = viewportH + 2 * OVERSCAN_ROWS
    const minStart = Math.max(0, end - MAX_MOUNTED_ITEMS)
    let coverage = 0
    for (let i = start; i < end; i++) {
      coverage += heightCache.current.get(itemKeys[i]!) ?? PESSIMISTIC_HEIGHT
    }
    while (start > minStart && coverage < needed) {
      start--
      coverage +=
        heightCache.current.get(itemKeys[start]!) ?? PESSIMISTIC_HEIGHT
    }
    // Slide cap：限制本次 commit 新增挂载的项目数。否则，滚进一个全新 range 时，
    // 在 PESSIMISTIC_HEIGHT=1 的覆盖假设下会一次挂上 194 个项目，
    // 形成约 290ms 的 React 渲染阻塞。门槛由滚动速度决定
    // （|scrollTop 与上次 commit 的差值| > 2×viewportH；连发 PageUp 时每次约移动 viewportH/2，
    // 3 次以上批量合并即可视作 fast mode）。同时覆盖
    // scrollBy（pendingDelta）和 scrollTo（直接写入）。普通的
    // 单次 PageUp 或 sticky 失效跳转不会触发。clamp（setClampBounds）会在追赶期间
    // 把视口固定在已挂载边缘。这里只限制 range 的增长；收缩不受限。
    const prev = prevRangeRef.current
    const scrollVelocity =
      Math.abs(scrollTop - lastScrollTopRef.current) + Math.abs(pendingDelta)
    if (prev && scrollVelocity > viewportH * 2) {
      const [pS, pE] = prev
      if (start < pS - SLIDE_STEP) start = pS - SLIDE_STEP
      if (end > pE + SLIDE_STEP) end = pE + SLIDE_STEP
      // 大幅向前跳转时，start 可能越过被限制后的 end（start 由二分搜索推进，
      // 而 end 被钳在 pE + SLIDE_STEP）。这时就从新的 start 处挂上
      // SLIDE_STEP 个项目，避免追赶过程中视口变空。
      if (start > end) end = Math.min(start + SLIDE_STEP, n)
    }
    lastScrollTopRef.current = scrollTop
  }

  // 在 range 计算完成之后再递减 freeze。冻结期间不要更新 prevRangeRef，
  // 这样两次被冻结的渲染都会复用“原始的” resize 前 range，
  // 而不是使用消息在冻结期间变化后被钳到 n 的版本。
  if (freezeRendersRef.current > 0) {
    freezeRendersRef.current--
  } else {
    prevRangeRef.current = [start, end]
  }
  // useDeferredValue 允许 React 先用旧 range 渲染（便宜，
  // 基本全是 memo 命中），再过渡到新 range（昂贵，因为会新增挂载并执行
  // marked.lexer + formatToken）。紧急渲染能让 Ink 继续按输入速率绘制；
  // 新挂载则放到一个不阻塞的后台渲染中。这正是 React 原生的时间切片：
  // 原本 62ms 的 fresh-mount 阻塞会变成可中断。clamp（setClampBounds）
  // 已经负责把视口钉住，因此 deferred range 短暂落后于 scrollTop 时不会产生可见伪影。
  //
  // 这里只延迟 range 的“增长”部分（start 更早、end 更晚都会新增挂载）。
  // 收缩很便宜（unmount 只是移除 fiber，不需要解析），而且如果 deferred value 落后于收缩，
  // 只会让过期的 overscan 多挂一 tick，虽然无害，但会让那些依赖测量驱动收紧后
  // 精确 range 的测试失败。
  const dStart = useDeferredValue(start)
  const dEnd = useDeferredValue(end)
  let effStart = start < dStart ? dStart : start
  let effEnd = end > dEnd ? dEnd : end
  // 大跳转可能导致 effStart > effEnd（start 向前跳了，但 dEnd
  // 还停留在旧 range 的 end）。此时跳过 deferral，避免得到倒置区间。
  // sticky 情况下也跳过，因为 scrollToBottom 需要立刻把尾部挂上，
  // 这样 scrollTop=maxScroll 才会落在内容上，而不是落在 bottomSpacer 上。
  // 若继续使用 deferred dEnd（仍停留在旧 range），就会只渲染不完整的尾部，
  // maxScroll 也会停在旧内容高度，导致“跳到底部”不够到底。
  // sticky snap 只是一帧行为，不是连续滚动，因此时间切片在这里没有收益。
  if (effStart > effEnd || isSticky) {
    effStart = start
    effEnd = end
  }
  // 向下滚动（pendingDelta > 0）时，绕过 effEnd 的延迟，这样尾部会立刻挂载。
  // 否则，基于 effEnd 的 clamp 会把 scrollTop 卡在真实底部之前，表现为：
  // 用户向下滚动，撞上 clampMax 后停住，React 之后补上 effEnd、放宽 clampMax，
  // 但用户已经松手，于是感觉像“卡在底部前一点”。
  // effStart 仍然保持 deferred，这样向上滚动时仍能享受时间切片
  // （旧消息在挂载时要做解析，这是更昂贵的方向）。
  if (pendingDelta > 0) {
    effEnd = end
  }
  // 最后的 O(viewport) 级别约束。中间的各种限制（maxEnd=start+
  // MAX_MOUNTED_ITEMS、slide cap、deferred-intersection）已经约束了 [start,end]，
  // 但上面的 deferred+bypass 组合仍可能让 [effStart,effEnd] 漏出去：
  // 例如持续 PageUp 时，并发模式可能在多次 commit 间把 dStart 的更新与 effEnd=end 的绕过交错起来，
  // 导致有效窗口比单独的 immediate 或 deferred 都更宽。
  // 在一个恢复出来的 10K 行会话里，这曾表现为 PageUp 狂按时多出 270MB RSS，
  // 因为 yoga Node 构造和 createWorkInProgress fiber 分配都会随着滚动距离增长。
  // 因此要按视口位置裁掉远端边缘，确保无论 deferred-value 如何调度，
  // fiber 数量都保持在 O(viewport)。
  if (effEnd - effStart > MAX_MOUNTED_ITEMS) {
    // 裁哪一侧由视口“当前位置”决定，而不是 pendingDelta 的方向。
    // 因为 pendingDelta 会在多帧间逐渐排空到 0，而 dStart/dEnd 在并发调度下会滞后；
    // 如果按方向裁剪，就可能在尚未稳定的中途从“裁尾部”突然切换成“裁头部”，
    // 进而推动 effStart → effTopSpacer → clampMin → setClampBounds，
    // 最终把 scrollTop 硬拽下去，让滚动历史瞬间消失。
    // 按位置裁剪则意味着保留视口更靠近的一端。
    const mid = (offsets[effStart]! + offsets[effEnd]!) / 2
    if (scrollTop - listOriginRef.current < mid) {
      effEnd = effStart + MAX_MOUNTED_ITEMS
    } else {
      effStart = effEnd - MAX_MOUNTED_ITEMS
    }
  }

  // 在 layout effect 中写入渲染期的 clamp 边界（不能在 render 中写，
  // 否则就是在 React 渲染期间修改 DOM，破坏纯函数语义）。render-node-to-output
  // 会把 scrollTop 钳在这个区间内，因此那些超前于 React 异步重渲染的密集 scrollTo 调用，
  // 最终看到的是“已挂载内容的边缘”（最后/最前的可见消息），而不是空 spacer。
  //
  // clamp 必须使用 EFFECTIVE（也就是 deferred 后）的 range，而不是 immediate range。
  // 在快速滚动时，immediate [start,end] 可能已经覆盖到新的 scrollTop，
  // 但 children 实际上仍以 deferred（更旧）的 range 渲染。如果 clamp 用的是 immediate 边界，
  // render-node-to-output 中的 drain-gate 会认为 scrollTop 仍在 clamp 内，
  // 于是继续排空到 deferred children 的区间之外，最终让视口落进 spacer，出现白闪。
  // 使用 effStart/effEnd 才能让 clamp 与真正已挂载的内容保持同步。
  //
  // sticky 时跳过 clamp，因为 render-node-to-output 会权威地把 scrollTop 钉到 maxScroll。
  // 冷启动/加载期间若启用 clamp，会造成闪烁：第一次渲染使用估算 offsets 并设置 clamp，
  // sticky-follow 移动了 scrollTop；接着测量触发，offsets 用真实高度重建；
  // 第二次渲染的 clamp 边界不同，于是 scrollTop 被再次调整，内容就会位移。
  const listOrigin = listOriginRef.current
  const effTopSpacer = offsets[effStart]!
  // effStart=0 时，上方没有未挂载内容，因此 clamp 必须允许用户越过 listOrigin
  // 继续往上，看见位于 ScrollBox 内但不属于 VirtualMessageList 的列表前内容（logo、header）。
  // 只有 topSpacer 非零时才需要 clamp，也就是上方确实存在未挂载项目。
  const clampMin = effStart === 0 ? 0 : effTopSpacer + listOrigin
  // effEnd=n 时没有 bottomSpacer，因此无需防止滚过头。如果这里使用
  // offsets[n]，就等于把 heightCache（比 Yoga 慢一帧）固化进来；
  // 当尾部项目仍在 STREAMING 时，它的缓存高度会落后于真实高度，
  // 落后的幅度就是自上次测量后又新增的那部分内容。sticky 失效后，
  // 这会把 scrollTop 钳在真实 max 以下，导致正在流式输出的文本被推出视口
  // （也就是“往上滚后，回复消失了”的 bug）。Infinity 表示不设上界：
  // 此时交给 render-node-to-output 自己的 Math.min(cur, maxScroll) 来处理。
  const clampMax =
    effEnd === n
      ? Infinity
      : Math.max(effTopSpacer, offsets[effEnd]! - viewportH) + listOrigin
  useLayoutEffect(() => {
    if (isSticky) {
      scrollRef.current?.setClampBounds(undefined, undefined)
    } else {
      scrollRef.current?.setClampBounds(clampMin, clampMax)
    }
  })

  // 读取“上一轮 Ink 渲染”的高度。每次 commit 都运行（无依赖），
  // 因为 Yoga 会在 React 不知情的情况下重算布局。对于至少已挂载 1 帧的项目，
  // yogaNode 的高度是有效的；全新项目还没完成布局
  // （那发生在本 effect 之后的 resetAfterCommit → onRender 中）。
  //
  // 需要区分 “h=0：Yoga 还没跑”（临时状态，跳过）和 “h=0：
  // MessageRow 实际渲染为 null”（永久状态，应缓存）。getComputedWidth() > 0
  // 能证明 Yoga 已经处理过这个节点（宽度来自容器，列布局中的 Box 永远非零）。
  // 如果宽度已有而高度仍是 0，就说明该项确实为空，应缓存 0，
  // 否则 start 推进保护门会永远卡住它。没有这层逻辑时，
  // 起始边界上的一个 null-rendering message 会把 range 冻住
  // （表现为先向上滚再向下滚时视口一片空白）。
  //
  // 这里绝不能 setState。否则会基于偏移变化再调度第二次 commit，
  // 而 Ink 会在每次 commit 后都写 stdout
  // （reconciler.resetAfterCommit → onRender），结果就是两次使用不同 spacer 高度的输出写入，
  // 形成可见闪烁。高度会在下一次自然渲染中传播到 offsets；
  // 这一帧延迟由 overscan 吸收。
  useLayoutEffect(() => {
    const spacerYoga = spacerRef.current?.yogaNode
    if (spacerYoga && spacerYoga.getComputedWidth() > 0) {
      listOriginRef.current = spacerYoga.getComputedTop()
    }
    if (skipMeasurementRef.current) {
      skipMeasurementRef.current = false
      return
    }
    let anyChanged = false
    for (const [key, el] of itemRefs.current) {
      const yoga = el.yogaNode
      if (!yoga) continue
      const h = yoga.getComputedHeight()
      const prev = heightCache.current.get(key)
      if (h > 0) {
        if (prev !== h) {
          heightCache.current.set(key, h)
          anyChanged = true
        }
      } else if (yoga.getComputedWidth() > 0 && prev !== 0) {
        heightCache.current.set(key, 0)
        anyChanged = true
      }
    }
    if (anyChanged) offsetVersionRef.current++
  })

  // 稳定的按 key 回调 ref。只要回调的身份稳定，React 的 ref-swap 流程
  // （先 old(null) 再 new(el)）就会退化成 no-op，从而避免
  // itemRefs 在每次渲染时抖动。它们会与上方的 heightCache 一起被 GC。
  // ref(null) 这条路径还会在卸载时顺带捕获最终高度，
  // 因为那时 yogaNode 仍然有效（reconciler 会先调用 ref(null)，再执行 removeChild →
  // freeRecursive），所以我们能在 WASM 释放前拿到最后一次测量结果。
  const measureRef = useCallback((key: string) => {
    let fn = refCache.current.get(key)
    if (!fn) {
      fn = (el: DOMElement | null) => {
        if (el) {
          itemRefs.current.set(key, el)
        } else {
          const yoga = itemRefs.current.get(key)?.yogaNode
          if (yoga && !skipMeasurementRef.current) {
            const h = yoga.getComputedHeight()
            if (
              (h > 0 || yoga.getComputedWidth() > 0) &&
              heightCache.current.get(key) !== h
            ) {
              heightCache.current.set(key, h)
              offsetVersionRef.current++
            }
          }
          itemRefs.current.delete(key)
        }
      }
      refCache.current.set(key, fn)
    }
    return fn
  }, [])

  const getItemTop = useCallback(
    (index: number) => {
      const yoga = itemRefs.current.get(itemKeys[index]!)?.yogaNode
      if (!yoga || yoga.getComputedWidth() === 0) return -1
      return yoga.getComputedTop()
    },
    [itemKeys],
  )

  const getItemElement = useCallback(
    (index: number) => itemRefs.current.get(itemKeys[index]!) ?? null,
    [itemKeys],
  )
  const getItemHeight = useCallback(
    (index: number) => heightCache.current.get(itemKeys[index]!),
    [itemKeys],
  )
  const scrollToIndex = useCallback(
    (i: number) => {
      // offsetsRef.current 始终保存着最新缓存 offsets
      // （事件处理器运行在多次渲染之间，若直接闭包捕获渲染期值就会过期）。
      const o = offsetsRef.current
      if (i < 0 || i >= o.n) return
      scrollRef.current?.scrollTo(o.arr[i]! + listOriginRef.current)
    },
    [scrollRef],
  )

  const effBottomSpacer = totalHeight - offsets[effEnd]!

  return {
    range: [effStart, effEnd],
    topSpacer: effTopSpacer,
    bottomSpacer: effBottomSpacer,
    measureRef,
    spacerRef,
    offsets,
    getItemTop,
    getItemElement,
    getItemHeight,
    scrollToIndex,
  }
}
