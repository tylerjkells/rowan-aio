import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './themes.css'
import './styles.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// the app shell works offline once loaded; data comes from the last visit
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
