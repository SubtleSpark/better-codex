export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
export const ENGINE_PACKAGE_VERSION = '0.2.0';

export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// MVP 只接受自包含图；不从 Markdown 读取文件、URL、环境变量或预处理宏。
// 这是保守的输入限制，不应被描述为操作系统 sandbox。
export function prepareSource(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw failure('EMPTY_SOURCE', 'PlantUML 源码为空。');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SOURCE_BYTES) {
    throw failure('SOURCE_TOO_LARGE', '图源码超过 64 KiB，请拆成较小的图。');
  }
  const source = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^\s*!/m.test(source) || /%[a-z_][a-z_0-9]*\s*\(/i.test(source) || /<\s*img\b/i.test(source)) {
    throw failure('UNSUPPORTED_DIRECTIVE', '本地 MVP 暂不支持 ! 预处理指令、% 函数和外部图片。源码未发送到任何服务器。');
  }
  const starts = source.match(/^\s*@start\w+/gim) || [];
  const ends = source.match(/^\s*@end\w+/gim) || [];
  if (!starts.length && !ends.length) return `@startuml\n${source}\n@enduml`;
  if (starts.length !== 1 || ends.length !== 1 ||
      !/^@startuml\b/i.test(source) || !/@enduml\s*$/i.test(source) ||
      starts[0].trim().toLowerCase() !== '@startuml' || ends[0].trim().toLowerCase() !== '@enduml') {
    throw failure('UNSUPPORTED_BLOCK', '每个代码块暂只支持一张 @startuml / @enduml 图。');
  }
  return source;
}
