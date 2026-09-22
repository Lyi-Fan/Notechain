import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useReadingNavigation } from '../navigation'

export function NavigationControls() {
  const { canGoBack, canGoForward, goBack, goForward } = useReadingNavigation()
  return <div className="navigation-controls">
    <button className="icon-button" type="button" onClick={goBack} disabled={!canGoBack} aria-label="后退" title="后退"><ChevronLeft size={17} /></button>
    <button className="icon-button" type="button" onClick={goForward} disabled={!canGoForward} aria-label="前进" title="前进"><ChevronRight size={17} /></button>
  </div>
}
