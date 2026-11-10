// 本地时区日期字符串（YYYY-MM-DD）：导出默认文件名、年化期末估值日与快照的新鲜度共用。

export function todayString(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
