// 存储所有 Ink 实例（instance.js），确保连续的 render() 调用会复用同一个
// Ink 实例，而不是重新创建新的实例。
//
// 这个 map 必须放在单独的文件里，因为 render.js 会创建实例，而 instance.js
// 则需要在 unmount 时把自己从该 map 中删除。

import type Ink from './ink.js'

const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
