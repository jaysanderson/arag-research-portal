import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { TenantPicker } from './pages/TenantPicker.tsx'
import { TenantLayout } from './pages/TenantLayout.tsx'
import { ExplorePage } from './pages/ExplorePage.tsx'
import { SearchPage } from './pages/SearchPage.tsx'
import { AdminPage } from './pages/AdminPage.tsx'
import { LibraryPage } from './pages/LibraryPage.tsx'
import { ResourceDetailPage } from './pages/ResourceDetailPage.tsx'
import { AssistantPage } from './pages/AssistantPage.tsx'
import { AgenticPage } from './pages/AgenticPage.tsx'
import { GeneratePage } from './pages/GeneratePage.tsx'
import { GraphPage } from './pages/GraphPage.tsx'
import { TaxonomyPage } from './pages/TaxonomyPage.tsx'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root not found')
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path='/' element={<TenantPicker />} />
          <Route path='/admin' element={<AdminPage />} />
          <Route path='/t/:slug' element={<TenantLayout />}>
            <Route index element={<ExplorePage />} />
            <Route path='search' element={<SearchPage />} />
            <Route path='library' element={<LibraryPage />} />
            <Route path='library/:id' element={<ResourceDetailPage />} />
            <Route path='assistant' element={<AssistantPage />} />
            <Route path='agentic' element={<AgenticPage />} />
            <Route path='generate' element={<GeneratePage />} />
            <Route path='graph' element={<GraphPage />} />
            <Route path='taxonomy' element={<TaxonomyPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
