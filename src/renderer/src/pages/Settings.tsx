import { useEffect, useState } from 'react'

export default function Settings(): React.JSX.Element {
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null)

  useEffect(() => {
    window.api.dbInfo().then(setDbInfo)
  }, [])

  return (
    <section className="page">
      <h1>设置</h1>
      {dbInfo && (
        <div className="db-info">
          <p>数据文件：{dbInfo.path}</p>
          <p>Schema 版本：{dbInfo.schemaVersion}</p>
          <p>数据表：{dbInfo.tables.join('、')}</p>
        </div>
      )}
      <p className="placeholder">备份导出等功能将在后续里程碑实现。</p>
    </section>
  )
}
