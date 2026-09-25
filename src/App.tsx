import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppProvider } from '@/store/AppStore'
import { AppShell } from '@/components/AppShell'
import { HomePage } from '@/pages/Home'
import { LibraryPage } from '@/pages/Library'
import { PaperDetailPage } from '@/pages/PaperDetail'
import { ComparePage } from '@/pages/Compare'
import { CheckPage } from '@/pages/Check'
import { QaPage } from '@/pages/Qa'
import { PlanPage } from '@/pages/Plan'
import { LabPage } from '@/pages/Lab'
import { CollectionsPage } from '@/pages/Collections'
import { MapPage } from '@/pages/Map'
import { DirectionsPage } from '@/pages/Directions'
import { EmptyState } from '@/components/EmptyState'

function ScrollToTop() {
  const location = useLocation()
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [location.pathname])
  return null
}

function NotFound() {
  return (
    <div className="page">
      <EmptyState
        icon="🧭"
        title="页面不存在"
        description="可能是链接过期或地址写错了。可以从左侧导航回到论文库或首页。"
        actions={
          <a className="btn btn-primary" href="#/library">
            回到论文库
          </a>
        }
      />
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AppProvider>
        <ScrollToTop />
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/paper/:paperId" element={<PaperDetailPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/check" element={<CheckPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/lab" element={<LabPage />} />
            <Route path="/qa" element={<QaPage />} />
            <Route path="/collections" element={<CollectionsPage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/directions" element={<DirectionsPage />} />
            <Route path="/index.html" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </AppProvider>
    </HashRouter>
  )
}
