/**
 * 打印本次启动的**有效配置来源**（统一启动方案的一部分）。
 *
 * 开发启动、restart 脚本与便携版入口都调用这一个脚本，
 * 保证三者对「配置从哪来、有没有、优先级如何」的说法完全一致。
 * 只输出键名与来源文件名，绝不输出密钥取值。
 *
 * 用法：node scripts/env-report.mjs
 */
import { envReport, CONFIG_FILES } from '../server/loadenv.mjs'

const r = envReport()
const lines = []
lines.push('[config] 优先级（高 → 低）：' + r.priority.join(' > '))
lines.push('[config] 检测到的配置文件：' + (r.filesPresent.length ? r.filesPresent.join(', ') : '（无）'))
lines.push('[config] 来自进程环境变量：' + (r.fromProcess.length ? r.fromProcess.join(', ') : '（无）'))
if (r.fromFile.length) {
  for (const f of r.fromFile) lines.push(`[config] 来自 ${f.file}：${f.keys.join(', ')}`)
} else {
  lines.push('[config] 来自配置文件：' + CONFIG_FILES.join(' / ') + ' 都没有提供有效键')
}
lines.push('[config] 模型密钥：' + (r.hasCredentials ? '已配置' : '未配置'))
lines.push('[config] ' + r.guidance)
console.log(lines.join('\n'))
