import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
// Self-hosted fonts (bundled + precached) so the PWA keeps working offline:
// Lora for everything you read, Inter for UI plumbing.
import '@fontsource/lora/400.css'
import '@fontsource/lora/400-italic.css'
import '@fontsource/lora/500.css'
import '@fontsource/lora/600.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
