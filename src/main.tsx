import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { LedgerProvider } from './store'
import { ReadingNavigationProvider } from './navigation'
import App from './App'
import './styles.css'
import './workspace.css'
import './notebook.css'
import './mac.css'
import { initializePlatform } from './platform'

initializePlatform().then(() => ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <LedgerProvider>
        <ReadingNavigationProvider>
          <App />
        </ReadingNavigationProvider>
      </LedgerProvider>
    </BrowserRouter>
  </React.StrictMode>,
)).catch(() => { document.getElementById('root')!.textContent = '无法打开本地数据库。请检查存储目录权限后重新启动。' })
