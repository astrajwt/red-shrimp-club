import { useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent, type CompositionEvent } from 'react'

export function isImeComposing(event: ReactKeyboardEvent<Element>) {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean }
  const syntheticEvent = event as ReactKeyboardEvent<Element> & { isComposing?: boolean }

  return event.key === 'Process'
    || nativeEvent.isComposing === true
    || syntheticEvent.isComposing === true
    || event.keyCode === 229
}

/**
 * Hook that tracks IME composition state via compositionstart/compositionend.
 * Some browsers/IMEs fire the confirming Enter with isComposing=false,
 * so we keep a flag that stays true until the *next* event loop tick
 * after compositionend, preventing the Enter from leaking through.
 */
export function useImeGuard() {
  const composing = useRef(false)

  const onCompositionStart = useCallback((_e: CompositionEvent<Element>) => {
    composing.current = true
  }, [])

  const onCompositionEnd = useCallback((_e: CompositionEvent<Element>) => {
    // Delay clearing so the keydown that ends composition is still guarded
    setTimeout(() => { composing.current = false }, 0)
  }, [])

  const isComposingRef = composing

  return { onCompositionStart, onCompositionEnd, isComposingRef }
}
