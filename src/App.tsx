import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import { CaseHome } from './components/CaseHome'
import { CaseLayout } from './components/CaseWorkspace'
import { CaseOverview } from './components/CaseOverview'
import { AssetNote as AssetDetail } from './components/AssetNote'
import { FindingsPage, FindingRoute } from './components/FindingsPage'
import { TransferTrayProvider } from './components/TransferTray'
import { FileNotebooks, NotebookOpenBridge } from './components/FileNotebooks'
import { ledgerStorage } from './native-storage'

function Home() { return ledgerStorage.getItem('asset-ledger-mode') === 'notes' ? <Navigate to="/notebooks" replace /> : <CaseHome /> }

export default function App() {
  const { pathname } = useLocation()
  useEffect(() => { if (pathname.startsWith('/cases/')) ledgerStorage.setItem('asset-ledger-mode', 'assets') }, [pathname])
  return <TransferTrayProvider><NotebookOpenBridge /><Routes>
    <Route path="/" element={<Home />} />
    <Route path="/notebooks" element={<FileNotebooks />} />
    <Route path="/notebooks/:notebookId" element={<FileNotebooks />} />
    <Route path="/cases/:caseId" element={<CaseLayout />}>
      <Route index element={<CaseOverview />} />
      <Route path="assets/:assetId" element={<AssetDetail />} />
      <Route path="findings" element={<FindingsPage />} />
      <Route path="findings/:findingId" element={<FindingRoute />} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></TransferTrayProvider>
}
