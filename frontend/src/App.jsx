import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const API_BASE_URL = 'http://localhost:3030'

const SOURCE_TYPES = [
  { id: 'url', label: 'Article URL' },
  { id: 'text', label: 'Paste Text' },
  { id: 'prompt', label: 'Ask ChatGPT' },
  { id: 'load', label: 'Load' }
]

const SENTENCE_STUDY_SEQUENCE = ['audioFrUrl', 'audioEnUrl', 'audioFrUrl']
const KEY_VOCAB_SEQUENCE = ['audioFrUrl', 'audioEnUrl', 'audioFrUrl']
const STUDY_DELAY_MS = 250

const createDefaultStudyState = () => ({
  active: false,
  index: null,
  step: 0,
  mode: null,
  vocabIndex: 0
})

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
  const [showFrench, setShowFrench] = useState(false)
  const [showEnglish, setShowEnglish] = useState(false)
  const [showKeyVocab, setShowKeyVocab] = useState(false)
  const [studyState, setStudyState] = useState(createDefaultStudyState)
  const [resumeReady, setResumeReady] = useState(false)
  const [expandedSentenceIds, setExpandedSentenceIds] = useState(() => new Set())
  const [viewMode, setViewMode] = useState('setup')
  const [savedSessions, setSavedSessions] = useState([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [loadingSessionId, setLoadingSessionId] = useState(null)
  const [editingSessionId, setEditingSessionId] = useState(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [updatingSessionId, setUpdatingSessionId] = useState(null)
  const [deletingSessionId, setDeletingSessionId] = useState(null)

  const audioRef = useRef(null)
  const previousObjectUrlsRef = useRef([])
  const wasPlayingBeforeStudyRef = useRef(false)
  const studyDelayTimeoutRef = useRef(null)

  const clearStudyDelayTimeout = useCallback(() => {
    if (studyDelayTimeoutRef.current) {
      clearTimeout(studyDelayTimeoutRef.current)
      studyDelayTimeoutRef.current = null
    }
  }, [])

  const scheduleStudyContinuation = useCallback(
    (callback) => {
      clearStudyDelayTimeout()
      studyDelayTimeoutRef.current = setTimeout(() => {
        studyDelayTimeoutRef.current = null
        callback()
      }, STUDY_DELAY_MS)
    },
    [clearStudyDelayTimeout]
  )

  const stopStudyMode = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.onended = null
      audio.onerror = null
      audioRef.current = null
    }
    clearStudyDelayTimeout()
    setIsPlaying(false)
    setStudyState(createDefaultStudyState())
    setResumeReady(Boolean(wasPlayingBeforeStudyRef.current))
  }, [clearStudyDelayTimeout])

  const hasConfirmedText = useMemo(() => {
    if (sourceType === 'text') {
      return draftText.trim().length > 0
    }
    return confirmedText.trim().length > 0
  }, [confirmedText, draftText, sourceType])
  const hasSegments = segments.length > 0
  const currentSegment = hasSegments ? segments[currentSentenceIndex] : null
  const currentSegmentHasKeyVocab = Array.isArray(currentSegment?.keyVocab) && currentSegment.keyVocab.length > 0
  const isSentenceStudyActive = studyState.active && studyState.mode === 'sentence'
  const isKeyVocabStudyActive = studyState.active && studyState.mode === 'keyVocab'

  const resetPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current = null
    }
    clearStudyDelayTimeout()
    setIsPlaying(false)
    setStudyState(createDefaultStudyState())
    setResumeReady(false)
  }, [clearStudyDelayTimeout])

  const revokePreviousUrls = useCallback(() => {
    previousObjectUrlsRef.current.forEach((url) => {
      if (url) {
        URL.revokeObjectURL(url)
      }
    })
    previousObjectUrlsRef.current = []
  }, [])

  const fetchSavedSessions = useCallback(async () => {
    setError('')
    setIsLoadingSessions(true)
    try {
      const response = await fetch(`${API_BASE_URL}/api/sessions`)
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Unable to retrieve saved sessions.')
      }
      const sessions = Array.isArray(data.sessions) ? data.sessions : []
      setSavedSessions(sessions)
      setEditingSessionId(null)
      setEditingTitle('')
      setUpdatingSessionId(null)
      setDeletingSessionId(null)
    } catch (fetchError) {
      console.error(fetchError)
      setError(fetchError instanceof Error ? fetchError.message : 'Unable to retrieve saved sessions.')
    } finally {
      setIsLoadingSessions(false)
    }
  }, [])

  useEffect(() => {
    return () => {
      resetPlayback()
      revokePreviousUrls()
    }
  }, [resetPlayback, revokePreviousUrls])

  useEffect(() => {
    if (sourceType === 'load') {
      setError('')
      fetchSavedSessions()
    }
  }, [fetchSavedSessions, sourceType])

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
    if (studyState.active && studyState.mode === 'sentence') {
      stopStudyMode()
      return
    }
    wasPlayingBeforeStudyRef.current = isPlaying
    resetPlayback()
    setStudyState({ ...createDefaultStudyState(), active: true, index: currentSentenceIndex, mode: 'sentence' })
  }, [
    currentSentenceIndex,
    hasSegments,
    isPlaying,
    resetPlayback,
    stopStudyMode,
    studyState.active,
    studyState.mode
  ])

  const handleStudyKeyVocab = useCallback(() => {
    if (!hasSegments || !currentSegmentHasKeyVocab) return
    if (studyState.active && studyState.mode === 'keyVocab') {
      stopStudyMode()
      return
    }
    wasPlayingBeforeStudyRef.current = isPlaying
    resetPlayback()
    setStudyState({
      ...createDefaultStudyState(),
      active: true,
      index: currentSentenceIndex,
      mode: 'keyVocab',
      vocabIndex: 0
    })
  }, [
    currentSentenceIndex,
    currentSegmentHasKeyVocab,
    hasSegments,
    isPlaying,
    resetPlayback,
    stopStudyMode,
    studyState.active,
    studyState.mode
  ])

  const toggleSentenceExpanded = useCallback((segmentId) => {
    setExpandedSentenceIds((previous) => {
      const next = new Set(previous)
      if (next.has(segmentId)) {
        next.delete(segmentId)
      } else {
        next.add(segmentId)
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (!studyState.active || studyState.index == null) {
      return
    }

    const segment = segments[studyState.index]
    if (!segment) {
      setStudyState(createDefaultStudyState())
      return
    }

    if (studyState.mode === 'sentence') {
      const audioKey = SENTENCE_STUDY_SEQUENCE[studyState.step]
      const url = segment[audioKey]

      attachAudio(url, 'study', () => {
        scheduleStudyContinuation(() => {
          let shouldMarkResume = false
          setStudyState((previous) => {
            if (previous.mode !== 'sentence') {
              return previous
            }
            const nextStep = previous.step + 1
            if (nextStep < SENTENCE_STUDY_SEQUENCE.length) {
              return { ...previous, step: nextStep }
            }
            shouldMarkResume = true
            return createDefaultStudyState()
          })
          if (shouldMarkResume) {
            setResumeReady(true)
          }
        })
      })
      return
    }

    if (studyState.mode === 'keyVocab') {
      const vocabList = Array.isArray(segment.keyVocab) ? segment.keyVocab : []
      const nextSentenceIndex = studyState.index + 1
      const hasNextSentence = nextSentenceIndex < segments.length

      const startNextSentence = () => {
        if (!hasNextSentence) {
          setResumeReady(true)
          setStudyState(createDefaultStudyState())
          return
        }
        setResumeReady(false)
        setCurrentSentenceIndex(nextSentenceIndex)
        setStudyState(() => {
          const nextState = createDefaultStudyState()
          nextState.active = true
          nextState.index = nextSentenceIndex
          nextState.mode = 'keyVocab'
          nextState.vocabIndex = 0
          return nextState
        })
      }

      if (!vocabList.length || studyState.vocabIndex >= vocabList.length) {
        scheduleStudyContinuation(() => {
          if (segment.audioFrUrl) {
            attachAudio(segment.audioFrUrl, 'study', () => {
              scheduleStudyContinuation(() => {
                startNextSentence()
              })
            })
            return
          }
          startNextSentence()
        })
        return
      }

      const vocab = vocabList[studyState.vocabIndex]
      const audioKey = KEY_VOCAB_SEQUENCE[studyState.step]
      const url = vocab?.[audioKey]

      attachAudio(url, 'study', () => {
        scheduleStudyContinuation(() => {
          setStudyState((previous) => {
            if (previous.mode !== 'keyVocab') {
              return previous
            }
            let nextStep = previous.step + 1
            let nextVocabIndex = previous.vocabIndex
            if (nextStep >= KEY_VOCAB_SEQUENCE.length) {
              nextStep = 0
              nextVocabIndex += 1
            }
            return {
              ...previous,
              step: nextStep,
              vocabIndex: nextVocabIndex
            }
          })
        })
      })
    }
  }, [attachAudio, scheduleStudyContinuation, segments, studyState])

  const handleResume = useCallback(() => {
    setResumeReady(false)
    setStudyState(createDefaultStudyState())
    if (wasPlayingBeforeStudyRef.current) {
      playSentence(currentSentenceIndex)
    }
  }, [currentSentenceIndex, playSentence])

  const handleSelectSentence = useCallback(
    (index) => {
      if (!hasSegments || index < 0 || index >= segments.length) {
        return
      }

      if (index === currentSentenceIndex) {
        if (isPlaying && audioRef.current) {
          audioRef.current.pause()
          setIsPlaying(false)
          return
        }
      }

      resetPlayback()
      playSentence(index)
    },
    [currentSentenceIndex, hasSegments, isPlaying, playSentence, resetPlayback, segments.length]
  )

  useEffect(() => {
    setExpandedSentenceIds(new Set())
  }, [segments])

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

  const handleLoadSession = useCallback(
    async (sessionId) => {
      if (!sessionId) {
        return
      }
      setLoadingSessionId(sessionId)
      setError('')
      try {
        const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`)
        const data = await response.json()
        if (!response.ok) {
          throw new Error(data.error || 'Unable to load the selected session.')
        }

        const rawText = (data.raw_text || '').trim()
        const rawSegments = Array.isArray(data.segments) ? data.segments : []
        if (!rawSegments.length) {
          throw new Error('Saved session does not contain any segments.')
        }

        resetPlayback()
        revokePreviousUrls()

        const preparedSegments = rawSegments.map((segment, index) => {
          const audioFr = segment?.audio_fr || null
          const audioEn = segment?.audio_en || null
          const audioFrUrl = createAudioUrlFromBase64(audioFr)
          const audioEnUrl = createAudioUrlFromBase64(audioEn)
          if (audioFrUrl) {
            previousObjectUrlsRef.current.push(audioFrUrl)
          }
          if (audioEnUrl) {
            previousObjectUrlsRef.current.push(audioEnUrl)
          }

          const rawKeyVocab = Array.isArray(segment?.key_vocab)
            ? segment.key_vocab
            : Array.isArray(segment?.keyVocab)
              ? segment.keyVocab
              : []

          const preparedKeyVocab = rawKeyVocab
            .map((item, vocabIndex) => {
              const vocabAudioFr = item?.audio_fr || null
              const vocabAudioEn = item?.audio_en || null
              const vocabAudioFrUrl = createAudioUrlFromBase64(vocabAudioFr)
              const vocabAudioEnUrl = createAudioUrlFromBase64(vocabAudioEn)
              if (vocabAudioFrUrl) {
                previousObjectUrlsRef.current.push(vocabAudioFrUrl)
              }
              if (vocabAudioEnUrl) {
                previousObjectUrlsRef.current.push(vocabAudioEnUrl)
              }

              const french = (item?.french || '').trim()
              const english = (item?.english || '').trim()
              if (!french || !english) {
                return null
              }

              return {
                id: item?.id ?? `${segment?.id ?? index}-${vocabIndex}`,
                french,
                english,
                audio_fr: vocabAudioFr,
                audio_en: vocabAudioEn,
                audioFrUrl: vocabAudioFrUrl,
                audioEnUrl: vocabAudioEnUrl
              }
            })
            .filter(Boolean)

          return {
            id: segment?.id ?? index,
            french: (segment?.french || '').trim(),
            english: (segment?.english || '').trim(),
            audio_fr: audioFr,
            audio_en: audioEn,
            audioFrUrl,
            audioEnUrl,
            keyVocab: preparedKeyVocab
          }
        })

        setDraftText(rawText)
        setConfirmedText(rawText)
        setSegments(preparedSegments)
        setCurrentSentenceIndex(0)
        setViewMode('study')
      } catch (loadError) {
        console.error(loadError)
        setSegments([])
        setCurrentSentenceIndex(0)
        setViewMode('setup')
        setError(loadError instanceof Error ? loadError.message : 'Unable to load the selected session.')
      } finally {
        setLoadingSessionId(null)
      }
    },
    [resetPlayback, revokePreviousUrls]
  )

  const handleStartEditSession = useCallback((session) => {
    if (!session) {
      return
    }
    setError('')
    setEditingSessionId(session.id)
    setEditingTitle((session.title || `Lesson ${session.id}`).trim())
  }, [])

  const handleCancelEditSession = useCallback(() => {
    setEditingSessionId(null)
    setEditingTitle('')
  }, [])

  const handleSaveSessionTitle = useCallback(async () => {
    if (editingSessionId == null) {
      return
    }
    const trimmedTitle = editingTitle.trim()
    if (!trimmedTitle) {
      setError('Please provide a title before saving.')
      return
    }

    setUpdatingSessionId(editingSessionId)
    setError('')
    try {
      const response = await fetch(`${API_BASE_URL}/api/sessions/${editingSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmedTitle })
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || 'Unable to update session.')
      }
      setSavedSessions((previous) =>
        previous.map((session) => (session.id === editingSessionId ? { ...session, title: trimmedTitle } : session))
      )
      setEditingSessionId(null)
      setEditingTitle('')
    } catch (updateError) {
      console.error(updateError)
      setError(updateError instanceof Error ? updateError.message : 'Unable to update session.')
    } finally {
      setUpdatingSessionId(null)
    }
  }, [editingSessionId, editingTitle])

  const handleDeleteSession = useCallback(
    async (sessionId) => {
      if (!sessionId) {
        return
      }
      if (typeof window !== 'undefined' && !window.confirm('Delete this lesson? This cannot be undone.')) {
        return
      }

      setDeletingSessionId(sessionId)
      setError('')
      try {
        const response = await fetch(`${API_BASE_URL}/api/sessions/${sessionId}`, {
          method: 'DELETE'
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data.error || 'Unable to delete session.')
        }
        setSavedSessions((previous) => previous.filter((session) => session.id !== sessionId))
        if (editingSessionId === sessionId) {
          setEditingSessionId(null)
          setEditingTitle('')
        }
      } catch (deleteError) {
        console.error(deleteError)
        setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete session.')
      } finally {
        setDeletingSessionId(null)
      }
    },
    [editingSessionId]
  )

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
    const textToUse = (sourceType === 'text' ? draftText : confirmedText).trim()
    if (!textToUse) {
      setError(sourceType === 'text' ? 'Provide text before generating audio.' : 'Confirm the text before generating audio.')
      return
    }

    if (sourceType === 'text') {
      setConfirmedText(textToUse)
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
        .map((pair, index) => {
          const rawKeyVocab = Array.isArray(pair?.key_vocab) ? pair.key_vocab : []
          const keyVocab = rawKeyVocab
            .map((item) => ({
              french: (item?.french || '').trim(),
              english: (item?.english || '').trim()
            }))
            .filter((item) => item.french && item.english)

          return {
            id: pair?.id ?? index,
            french: (pair?.french || '').trim(),
            english: (pair?.english || '').trim(),
            keyVocab
          }
        })
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
          body: JSON.stringify({ french: pair.french, english: pair.english, key_vocab: pair.keyVocab })
        })

        const audioData = await audioResponse.json()
        if (!audioResponse.ok) {
          throw new Error(audioData.error || 'Audio generation failed')
        }

        const audioFrUrl = createAudioUrlFromBase64(audioData.audio_fr)
        const audioEnUrl = createAudioUrlFromBase64(audioData.audio_en)
        if (audioFrUrl) {
          previousObjectUrlsRef.current.push(audioFrUrl)
        }
        if (audioEnUrl) {
          previousObjectUrlsRef.current.push(audioEnUrl)
        }

        const audioKeyVocab = Array.isArray(audioData.key_vocab) ? audioData.key_vocab : []
        let keyVocab = audioKeyVocab
          .map((item, vocabIndex) => {
            const french = (item?.french || pair.keyVocab?.[vocabIndex]?.french || '').trim()
            const english = (item?.english || pair.keyVocab?.[vocabIndex]?.english || '').trim()
            if (!french || !english) {
              return null
            }
            const vocabAudioFrUrl = createAudioUrlFromBase64(item?.audio_fr)
            const vocabAudioEnUrl = createAudioUrlFromBase64(item?.audio_en)
            if (vocabAudioFrUrl) {
              previousObjectUrlsRef.current.push(vocabAudioFrUrl)
            }
            if (vocabAudioEnUrl) {
              previousObjectUrlsRef.current.push(vocabAudioEnUrl)
            }
            return {
              id: item?.id ?? `${pair.id}-${vocabIndex}`,
              french,
              english,
              audio_fr: item?.audio_fr || null,
              audio_en: item?.audio_en || null,
              audioFrUrl: vocabAudioFrUrl,
              audioEnUrl: vocabAudioEnUrl
            }
          })
          .filter(Boolean)

        if (Array.isArray(pair.keyVocab)) {
          pair.keyVocab.forEach((item, vocabIndex) => {
            const french = item?.french
            const english = item?.english
            if (!french || !english) {
              return
            }
            const alreadyIncluded = keyVocab.some(
              (existing) => existing?.french === french && existing?.english === english
            )
            if (!alreadyIncluded) {
              keyVocab.push({
                id: `${pair.id}-${vocabIndex}`,
                french,
                english,
                audio_fr: null,
                audio_en: null,
                audioFrUrl: null,
                audioEnUrl: null
              })
            }
          })
        }

        preparedSegments.push({
          id: pair.id,
          french: pair.french,
          english: pair.english,
          audio_fr: audioData.audio_fr,
          audio_en: audioData.audio_en,
          audioFrUrl,
          audioEnUrl,
          keyVocab
        })
      }

      const sessionPayload = {
        rawText: textToUse,
        segments: preparedSegments.map((segment) => ({
          id: segment.id,
          french: segment.french,
          english: segment.english,
          audio_fr: segment.audio_fr,
          audio_en: segment.audio_en,
          key_vocab: Array.isArray(segment.keyVocab)
            ? segment.keyVocab.map((item) => ({
                id: item?.id ?? null,
                french: item?.french || '',
                english: item?.english || '',
                audio_fr: item?.audio_fr || null,
                audio_en: item?.audio_en || null
              }))
            : []
        }))
      }

      try {
        const saveResponse = await fetch(`${API_BASE_URL}/api/save-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sessionPayload)
        })
        const saveData = await saveResponse.json().catch(() => ({}))
        if (!saveResponse.ok) {
          throw new Error(saveData.error || 'Automatic save failed.')
        }
      } catch (saveError) {
        console.error(saveError)
        const message = saveError instanceof Error ? saveError.message : 'Automatic save failed.'
        setError((previous) => previous || `Lesson generated but automatic save failed: ${message}`)
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
  }, [confirmedText, draftText, resetPlayback, revokePreviousUrls, sourceType])

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
      case 'load':
        return (
          <div className="field-group">
            <p className="load-intro">Pick a saved lesson to continue studying.</p>
            <div className="load-actions">
              <button type="button" onClick={fetchSavedSessions} disabled={isLoadingSessions}>
                {isLoadingSessions ? 'Refreshing…' : 'Refresh list'}
              </button>
            </div>
            {isLoadingSessions ? (
              <p className="load-empty">Loading saved lessons…</p>
            ) : savedSessions.length === 0 ? (
              <p className="load-empty">No saved lessons yet. Generate one to see it here.</p>
            ) : (
              <div className="load-sessions-grid">
                {savedSessions.map((session) => {
                  const previewText = (session?.preview || session?.raw_text || '').trim()
                  const snippet = previewText.length > 160 ? `${previewText.slice(0, 157)}…` : previewText
                  const isEditing = editingSessionId === session.id
                  const isUpdating = updatingSessionId === session.id
                  const isDeleting = deletingSessionId === session.id
                  const loadDisabled = loadingSessionId === session.id || isUpdating || isDeleting
                  return (
                    <article className="load-card" key={session.id}>
                      <header>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingTitle}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            className="load-card-title-input"
                            placeholder="Session title"
                            disabled={isUpdating}
                          />
                        ) : (
                          <h3>{(session?.title || `Lesson ${session.id}`).trim()}</h3>
                        )}
                      </header>
                      <p>{snippet || 'No preview available.'}</p>
                      <footer>
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              onClick={handleCancelEditSession}
                              disabled={isUpdating}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="primary"
                              onClick={handleSaveSessionTitle}
                              disabled={isUpdating || !editingTitle.trim()}
                            >
                              {isUpdating ? 'Saving…' : 'Save'}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="primary"
                              onClick={() => handleLoadSession(session.id)}
                              disabled={loadDisabled}
                            >
                              {loadingSessionId === session.id ? 'Loading…' : 'Load'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStartEditSession(session)}
                              disabled={loadDisabled}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteSession(session.id)}
                              disabled={loadDisabled}
                            >
                              {isDeleting ? 'Deleting…' : 'Delete'}
                            </button>
                          </>
                        )}
                      </footer>
                    </article>
                  )
                })}
              </div>
            )}
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

          {sourceType !== 'text' && sourceType !== 'load' && (
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
          )}

          {sourceType !== 'load' && (
            <section className="panel">
              <h2>3. Generate audio</h2>
              <button type="button" className="primary" onClick={handleGenerateAudio} disabled={!hasConfirmedText || isGeneratingAudio}>
                {isGeneratingAudio ? generationStatusMessage : 'Generate Audio'}
              </button>
            </section>
          )}

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
                <div className="primary-controls">
                  <button type="button" onClick={handleRewind} disabled={studyState.active}>
                    ⏮️ Sentence Back
                  </button>
                  <button type="button" onClick={handlePlayPause} disabled={studyState.active || resumeReady}>
                    {isPlaying ? '⏸️ Pause' : '▶️ Play'}
                  </button>
                  <button type="button" onClick={handleSkipForward} disabled={studyState.active}>
                    ⏭️ Next Sentence
                  </button>
                  {resumeReady && (
                    <button type="button" className="primary" onClick={handleResume}>
                      Resume lesson
                    </button>
                  )}
                </div>
                <div className="study-controls">
                  <button type="button" className="secondary" onClick={handleStudy} disabled={isKeyVocabStudyActive}>
                    {isSentenceStudyActive ? 'Pause Study Mode' : '🎧 Study Sentence'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleStudyKeyVocab}
                    disabled={isSentenceStudyActive || !currentSegmentHasKeyVocab}
                  >
                    {isKeyVocabStudyActive ? 'Pause Study Mode' : '🗝️ Study Key Vocab'}
                  </button>
                </div>
              </div>

              <div className="transcript-controls">
                <button type="button" onClick={() => setShowFrench((previous) => !previous)}>
                  FR {showFrench ? '👁️' : '🚫'}
                </button>
                <button type="button" onClick={() => setShowEnglish((previous) => !previous)}>
                  EN {showEnglish ? '👁️' : '🚫'}
                </button>
                <button type="button" onClick={() => setShowKeyVocab((previous) => !previous)}>
                  Key Vocab {showKeyVocab ? '👁️' : '🚫'}
                </button>
              </div>

              <ol className="transcript">
                {segments.map((segment, index) => {
                  const isActive = index === currentSentenceIndex && !studyState.active
                  const isCurrentlyPlaying = index === currentSentenceIndex && isPlaying
                  const isExpanded = expandedSentenceIds.has(segment.id)
                  return (
                    <li
                      key={segment.id}
                      className={isActive ? 'active' : ''}
                    >
                      <div className="sentence-header">
                        <span>Sentence {index + 1}</span>
                        <div className="sentence-actions">
                          <button
                            type="button"
                            className="sentence-play"
                            onClick={() => handleSelectSentence(index)}
                            disabled={studyState.active}
                          >
                            {isCurrentlyPlaying ? 'Pause' : 'Play'}
                          </button>
                          <button
                            type="button"
                            className="expand-toggle"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleSentenceExpanded(segment.id)
                            }}
                          >
                            {isExpanded ? 'Collapse' : 'Expand'}
                          </button>
                        </div>
                      </div>
                      {(showFrench || isExpanded) && <p className="french">{segment.french}</p>}
                      {(showEnglish || isExpanded) && <p className="english">{segment.english}</p>}
                      {((showKeyVocab || isExpanded) && segment.keyVocab?.length > 0) && (
                        <ul className="key-vocab-list">
                          {segment.keyVocab.map((item, vocabIndex) => (
                            <li key={item?.id ?? `${segment.id}-kv-${vocabIndex}`} className="key-vocab-item">
                              <span className="kv-fr">{item?.french}</span>
                              <span className="kv-en">{item?.english}</span>
                            </li>
                          ))}
                        </ul>
                      )}
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
