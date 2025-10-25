import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const API_BASE_URL = 'http://localhost:3030'

const SOURCE_TYPES = [
  { id: 'url', label: 'Article URL' },
  { id: 'text', label: 'Paste Text' },
  { id: 'prompt', label: 'Ask ChatGPT' }
]

const STUDY_SEQUENCE = ['audioFrUrl', 'audioEnUrl', 'audioFrUrl']

function createAudioUrlFromBase64(base64String) {
  if (!base64String) return null

  try {
    const byteCharacters = atob(base64String)
    const byteNumbers = new Array(byteCharacters.length)
    for (let i = 0; i < byteCharacters.length; i += 1) {
      byteNumbers[i] = byteCharacters.charCodeAt(i)
    }
    const byteArray = new Uint8Array(byteNumbers)
    const blob = new Blob([byteArray], { type: 'audio/mpeg' })
    return URL.createObjectURL(blob)
  } catch (error) {
    console.error('Failed to convert base64 audio into an object URL', error)
    return null
  }
}

function App() {
  const [sourceType, setSourceType] = useState('url')
  const [urlInput, setUrlInput] = useState('')
  const [promptInput, setPromptInput] = useState('')
  const [isFetchingText, setIsFetchingText] = useState(false)
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false)
  const [generationStage, setGenerationStage] = useState(null)
  const [generationProgress, setGenerationProgress] = useState({ current: 0, total: 0 })
  const [draftText, setDraftText] = useState('')
  const [confirmedText, setConfirmedText] = useState('')
  const [segments, setSegments] = useState([])
  const [currentSentenceIndex, setCurrentSentenceIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState('')
  const [showFrench, setShowFrench] = useState(true)
  const [showEnglish, setShowEnglish] = useState(true)
  const [studyState, setStudyState] = useState({ active: false, index: null, step: 0 })
  const [resumeReady, setResumeReady] = useState(false)
  const [viewMode, setViewMode] = useState('setup')

  const audioRef = useRef(null)
  const previousObjectUrlsRef = useRef([])
  const wasPlayingBeforeStudyRef = useRef(false)

  const hasConfirmedText = useMemo(() => confirmedText.trim().length > 0, [confirmedText])
  const hasSegments = segments.length > 0

  const resetPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current = null
    }
    setIsPlaying(false)
    setStudyState({ active: false, index: null, step: 0 })
    setResumeReady(false)
  }, [])

  const revokePreviousUrls = useCallback(() => {
    previousObjectUrlsRef.current.forEach((url) => {
      if (url) {
        URL.revokeObjectURL(url)
      }
    })
    previousObjectUrlsRef.current = []
  }, [])

  useEffect(() => {
    return () => {
      resetPlayback()
      revokePreviousUrls()
    }
  }, [resetPlayback, revokePreviousUrls])

  const attachAudio = useCallback((url, mode, onEnded) => {
    if (!url) {
      onEnded?.()
      return
    }

    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
    }

    const audio = new Audio(url)
    audioRef.current = audio
    audio.onended = () => {
      audio.onended = null
      onEnded?.()
    }
    audio.onerror = () => {
      console.error('Audio playback failed')
      onEnded?.()
    }

    audio
      .play()
      .then(() => {
        if (mode === 'main') {
          setIsPlaying(true)
        }
      })
      .catch((playError) => {
        console.error('Unable to start audio playback', playError)
        if (mode === 'main') {
          setIsPlaying(false)
        }
        onEnded?.()
      })
  }, [])

  const playSentence = useCallback(
    (index) => {
      const segment = segments[index]
      if (!segment || !segment.audioFrUrl) {
        return
      }

      setCurrentSentenceIndex(index)
      attachAudio(segment.audioFrUrl, 'main', () => {
        const nextIndex = index + 1
        if (nextIndex < segments.length) {
          playSentence(nextIndex)
        } else {
          setIsPlaying(false)
          audioRef.current = null
        }
      })
    },
    [attachAudio, segments]
  )

  const handlePlayPause = useCallback(() => {
    if (!hasSegments || studyState.active || resumeReady) {
      return
    }

    if (isPlaying) {
      if (audioRef.current) {
        audioRef.current.pause()
      }
      setIsPlaying(false)
      return
    }

    if (audioRef.current) {
      audioRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch((playError) => {
          console.error('Unable to resume playback', playError)
          setIsPlaying(false)
        })
      return
    }

    playSentence(currentSentenceIndex)
  }, [currentSentenceIndex, hasSegments, isPlaying, playSentence, resumeReady, studyState.active])

  const handleSkipForward = useCallback(() => {
    if (!hasSegments) return
    const nextIndex = Math.min(segments.length - 1, currentSentenceIndex + 1)
    setCurrentSentenceIndex(nextIndex)
    playSentence(nextIndex)
  }, [currentSentenceIndex, hasSegments, playSentence, segments.length])

  const handleRewind = useCallback(() => {
    if (!hasSegments) return
    const previousIndex = Math.max(0, currentSentenceIndex - 1)
    setCurrentSentenceIndex(previousIndex)
    playSentence(previousIndex)
  }, [currentSentenceIndex, hasSegments, playSentence])

  const handleStudy = useCallback(() => {
    if (!hasSegments) return
    wasPlayingBeforeStudyRef.current = isPlaying
    resetPlayback()
    setStudyState({ active: true, index: currentSentenceIndex, step: 0 })
  }, [currentSentenceIndex, hasSegments, isPlaying, resetPlayback])

  useEffect(() => {
    if (!studyState.active || studyState.index == null) {
      return
    }

    const segment = segments[studyState.index]
    if (!segment) {
      setStudyState({ active: false, index: null, step: 0 })
      return
    }

    const audioKey = STUDY_SEQUENCE[studyState.step]
    const url = segment[audioKey]

    attachAudio(url, 'study', () => {
      setStudyState((previous) => {
        const nextStep = previous.step + 1
        if (nextStep < STUDY_SEQUENCE.length) {
          return { ...previous, step: nextStep }
        }
        setResumeReady(true)
        return { active: false, index: null, step: 0 }
      })
    })
  }, [attachAudio, segments, studyState])

  const handleResume = useCallback(() => {
    setResumeReady(false)
    setStudyState({ active: false, index: null, step: 0 })
    if (wasPlayingBeforeStudyRef.current) {
      playSentence(currentSentenceIndex)
    }
  }, [currentSentenceIndex, playSentence])

  const handleSourceChange = useCallback(
    (event) => {
      const newType = event.target.value
      setSourceType(newType)
      setUrlInput('')
      setPromptInput('')
      setDraftText('')
      setConfirmedText('')
      setSegments([])
      setCurrentSentenceIndex(0)
      setError('')
      setViewMode('setup')
      resetPlayback()
      revokePreviousUrls()
    },
    [resetPlayback, revokePreviousUrls]
  )

  const fetchDraftText = useCallback(async () => {
    setIsFetchingText(true)
    setError('')
    try {
      const response = await fetch(`${API_BASE_URL}/api/fetch-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceType,
          url: urlInput,
          prompt: promptInput,
          text: draftText
        })
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Unable to retrieve text')
      }
      setDraftText(data.text)
      setConfirmedText('')
    } catch (fetchError) {
      console.error(fetchError)
      setError(fetchError.message)
    } finally {
      setIsFetchingText(false)
    }
  }, [draftText, promptInput, sourceType, urlInput])

  const handleConfirmText = useCallback(() => {
    if (!draftText.trim()) {
      setError('Please provide text to confirm.')
      return
    }
    setConfirmedText(draftText.trim())
    if (segments.length) {
      revokePreviousUrls()
      setSegments([])
      setCurrentSentenceIndex(0)
      setViewMode('setup')
      resetPlayback()
    }
    setError('')
  }, [draftText, resetPlayback, revokePreviousUrls, segments.length])

  const generationStatusMessage = useMemo(() => {
    if (!isGeneratingAudio) {
      return ''
    }

    if (generationStage === 'translating') {
      return 'Translating sentences'
    }

    if (generationStage === 'generating') {
      const { current, total } = generationProgress
      if (total > 0) {
        const displayed = Math.min(current + 1, total)
        return `Generating audio: ${displayed}/${total} sentences done`
      }
    }

    return 'Generating audio…'
  }, [generationProgress, generationStage, isGeneratingAudio])

  const handleGenerateAudio = useCallback(async () => {
    const textToUse = confirmedText.trim()
    if (!textToUse) {
      setError('Confirm the text before generating audio.')
      return
    }

    setIsGeneratingAudio(true)
    setGenerationStage('translating')
    setGenerationProgress({ current: 0, total: 0 })
    setError('')
    resetPlayback()
    setViewMode('setup')

    try {
      const translationResponse = await fetch(`${API_BASE_URL}/api/translate-sentences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToUse })
      })
      const translationData = await translationResponse.json()
      if (!translationResponse.ok) {
        throw new Error(translationData.error || 'Unable to translate sentences')
      }

      const translatedPairs = Array.isArray(translationData.sentences) ? translationData.sentences : []
      const sanitizedPairs = translatedPairs
        .map((pair, index) => ({
          id: pair?.id ?? index,
          french: (pair?.french || '').trim(),
          english: (pair?.english || '').trim()
        }))
        .filter((pair) => pair.french && pair.english)

      revokePreviousUrls()
      if (!sanitizedPairs.length) {
        setSegments([])
        setCurrentSentenceIndex(0)
        setError('No sentences were detected in the provided text.')
        return
      }

      const preparedSegments = []
      setGenerationStage('generating')
      setGenerationProgress({ current: 0, total: sanitizedPairs.length })

      for (let index = 0; index < sanitizedPairs.length; index += 1) {
        setGenerationProgress({ current: index, total: sanitizedPairs.length })
        const pair = sanitizedPairs[index]
        const audioResponse = await fetch(`${API_BASE_URL}/api/generate-segment-audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ french: pair.french, english: pair.english })
        })

        const audioData = await audioResponse.json()
        if (!audioResponse.ok) {
          throw new Error(audioData.error || 'Audio generation failed')
        }

        const audioFrUrl = createAudioUrlFromBase64(audioData.audio_fr)
        const audioEnUrl = createAudioUrlFromBase64(audioData.audio_en)
        previousObjectUrlsRef.current.push(audioFrUrl, audioEnUrl)
        preparedSegments.push({
          id: pair.id,
          french: pair.french,
          english: pair.english,
          audio_fr: audioData.audio_fr,
          audio_en: audioData.audio_en,
          audioFrUrl,
          audioEnUrl
        })
      }

      setSegments(preparedSegments)
      setCurrentSentenceIndex(0)
      setViewMode('study')
    } catch (generationError) {
      console.error(generationError)
      setError(generationError.message)
      revokePreviousUrls()
      setSegments([])
      setCurrentSentenceIndex(0)
      setViewMode('setup')
    } finally {
      setIsGeneratingAudio(false)
      setGenerationStage(null)
      setGenerationProgress({ current: 0, total: 0 })
    }
  }, [confirmedText, resetPlayback, revokePreviousUrls])

  useEffect(() => {
    if (!hasSegments && viewMode === 'study') {
      setViewMode('setup')
    }
  }, [hasSegments, viewMode])

  const handleOpenStudy = useCallback(() => {
    if (hasSegments) {
      setViewMode('study')
    }
  }, [hasSegments])

  const handleBackToSetup = useCallback(() => {
    resetPlayback()
    setViewMode('setup')
  }, [resetPlayback])

  const renderSourceControls = () => {
    switch (sourceType) {
      case 'url':
        return (
          <div className="field-group">
            <label htmlFor="url-input">Article URL</label>
            <input
              id="url-input"
              type="url"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="https://..."
            />
            <button type="button" onClick={fetchDraftText} disabled={isFetchingText || !urlInput.trim()}>
              {isFetchingText ? 'Fetching…' : 'Fetch Article'}
            </button>
          </div>
        )
      case 'prompt':
        return (
          <div className="field-group">
            <label htmlFor="prompt-input">Describe what you want to read</label>
            <textarea
              id="prompt-input"
              rows={4}
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
              placeholder="Ex: Write a short story about a trip to Marseille."
            />
            <button type="button" onClick={fetchDraftText} disabled={isFetchingText || !promptInput.trim()}>
              {isFetchingText ? 'Generating…' : 'Ask ChatGPT'}
            </button>
          </div>
        )
      default:
        return (
          <div className="field-group">
            <label htmlFor="manual-input">Paste French text</label>
            <textarea
              id="manual-input"
              rows={6}
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              placeholder="Paste or type French text here"
            />
          </div>
        )
    }
  }

  return (
    <main className="app-shell">
      <header>
        <h1>Language Learning Audio Studio</h1>
        <p>Generate bilingual audio lessons from any French text.</p>
      </header>

      {viewMode === 'setup' ? (
        <>
          <section className="panel">
            <h2>1. Choose your source</h2>
            <div className="source-picker">
              {SOURCE_TYPES.map((type) => (
                <label key={type.id} className={sourceType === type.id ? 'active' : ''}>
                  <input type="radio" name="source" value={type.id} checked={sourceType === type.id} onChange={handleSourceChange} />
                  {type.label}
                </label>
              ))}
            </div>
            {renderSourceControls()}
          </section>

          <section className="panel">
            <h2>2. Review and confirm the text</h2>
            <textarea
              className="review-text"
              rows={8}
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              placeholder="Your French text will appear here."
            />
            <div className="actions">
              <button type="button" onClick={handleConfirmText} disabled={!draftText.trim()}>
                Confirm Text
              </button>
            </div>
            {hasConfirmedText && <p className="hint">Text confirmed. You can still edit above and reconfirm if needed.</p>}
          </section>

          <section className="panel">
            <h2>3. Generate audio</h2>
            <button type="button" className="primary" onClick={handleGenerateAudio} disabled={!hasConfirmedText || isGeneratingAudio}>
              {isGeneratingAudio ? generationStatusMessage : 'Generate Audio'}
            </button>
          </section>

          {error && <div className="error">{error}</div>}

          {hasSegments && (
            <section className="panel ready-panel">
              <h2>4. Listen and study</h2>
              <p>Your lesson is ready! Head to the study view to listen and follow along with each sentence.</p>
              <button type="button" className="primary" onClick={handleOpenStudy}>
                Open Listen &amp; Study
              </button>
            </section>
          )}
        </>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          {hasSegments && (
            <section className="panel study-panel">
              <div className="study-header">
                <button type="button" className="back-button" onClick={handleBackToSetup}>
                  ← Back to steps 1–3
                </button>
                <h2>4. Listen and study</h2>
              </div>

              <div className="player-controls">
                <button type="button" onClick={handleRewind} disabled={studyState.active}>
                  ⏮️ Sentence Back
                </button>
                <button type="button" onClick={handlePlayPause} disabled={studyState.active || resumeReady}>
                  {isPlaying ? '⏸️ Pause' : '▶️ Play'}
                </button>
                <button type="button" onClick={handleSkipForward} disabled={studyState.active}>
                  ⏭️ Next Sentence
                </button>
                <button type="button" className="secondary" onClick={handleStudy} disabled={studyState.active}>
                  🎧 Study
                </button>
                {resumeReady && (
                  <button type="button" className="primary" onClick={handleResume}>
                    Resume lesson
                  </button>
                )}
              </div>

              <div className="transcript-controls">
                <button type="button" onClick={() => setShowFrench((previous) => !previous)}>
                  FR {showFrench ? '👁️' : '🚫'}
                </button>
                <button type="button" onClick={() => setShowEnglish((previous) => !previous)}>
                  EN {showEnglish ? '👁️' : '🚫'}
                </button>
              </div>

              <ol className="transcript">
                {segments.map((segment, index) => {
                  const isActive = index === currentSentenceIndex && !studyState.active
                  return (
                    <li key={segment.id} className={isActive ? 'active' : ''}>
                      <div className="sentence-header">
                        <span>Sentence {index + 1}</span>
                        <div className="tags">
                          <span className="tag">FR audio</span>
                          <span className="tag">EN audio</span>
                        </div>
                      </div>
                      {showFrench && <p className="french">{segment.french}</p>}
                      {showEnglish && <p className="english">{segment.english}</p>}
                    </li>
                  )
                })}
              </ol>
            </section>
          )}
        </>
      )}
    </main>
  )
}

export default App
