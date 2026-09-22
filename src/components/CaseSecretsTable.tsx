import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useLedger } from '../store'
import { caseSecrets } from '../secrets'

export function CaseSecretsTable({ caseId }: { caseId: string }) {
  const { state } = useLedger()
  const rows = useMemo(() => caseSecrets(state, caseId), [state.findings, state.assets, state.targets, state.cases, caseId])
  return <section className="case-secrets" aria-label="案件密钥汇总">
    <header><h2>密钥汇总</h2><span>{rows.length}</span></header>
    <div className="case-secrets-scroll"><table>
      <thead><tr><th scope="col">从哪找到的</th><th scope="col">来源资产/笔记</th><th scope="col">密码 / 密钥（明文）</th></tr></thead>
      <tbody>{rows.length ? rows.map(({ finding, source, sourceHref, category, location }) => <tr key={finding.id}>
        <td><span>{location || finding.howFound || source?.provenance.method || '未记录'}</span>{location && finding.howFound && <small>{finding.howFound}</small>}</td>
        <td>{sourceHref ? <Link className="case-secret-source" to={sourceHref}>{category}/{source?.title || '未命名笔记'}</Link> : <span>{category}/{source?.title || '来源笔记已移除'}{source?.deletedAt ? '（已归档）' : ''}</span>}</td>
        <td><code>{finding.value}</code></td>
      </tr>) : <tr><td className="case-secrets-empty" colSpan={3}>暂无已记录的密钥</td></tr>}</tbody>
    </table></div>
  </section>
}
