import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import './styles/theme.css'
import './styles/pages.css'
import './styles/gallery.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('找不到 #root 挂载点')
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
