import { useEffect, useState } from 'react'

function App() {
  const [message, setMessage] = useState('Loading message from the backend...')

  useEffect(() => {
    fetch('http://localhost:3030/api/hello')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Network response was not ok')
        }
        const data = await response.json()
        setMessage(data.message)
      })
      .catch((error) => {
        console.error('Failed to fetch hello message:', error)
        setMessage('Unable to load the greeting from the backend.')
      })
  }, [])

  return (
    <main className="container">
      <h1>React + Flask Hello World</h1>
      <p>{message}</p>
    </main>
  )
}

export default App
