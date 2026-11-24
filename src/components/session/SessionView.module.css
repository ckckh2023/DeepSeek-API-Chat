import { useEffect, useRef, useSyncExternalStore } from 'react'
import { create } from 'zustand'

/** 窄于 768px 按移动端布局 */
const query = window.matchMedia('not all and (min-width: 768px)')

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useIsMobile = () => useSyncExternalStore(subscribe, () => query.matches)

/** 视口变矮超过这个高度才算软键盘弹起，排除地址栏伸缩与窗口缩放 */
const KEYBOARD_MIN_INSET = 120

/**
 * 键盘弹起时页面已经贴着键盘顶部，home indicator 那条安全区被键盘整个盖住，
 * 输入框不该再为它留白（安卓由原生下发 0，iOS 的 env() 不会跟着键盘变）。
 * 标记写在 <html> 上，global.css 用它把 --safe-bottom-input 归零。
 */
const markKeyboardOpen = (open: boolean) => {
  const root = document.documentElement
  if (open) {
    root.dataset.keyboardOpen = ''
  } else {
    delete root.dataset.keyboardOpen
  }
}

/**
 * 正在编辑的消息 id。
 * 编辑已有消息时键盘只服务于内联编辑框，底部输入框不该跟着被顶到键盘上方，
 * useMobileViewport 读到后会锁住键盘弹起前的页面高度。
 */
type MessageEditingState = { ids: ReadonlySet<string> }

export const useMessageEditing = create<MessageEditingState>(() => ({ ids: new Set<string>() }))

export const beginMessageEdit = (id: string) => {
  const { ids } = useMessageEditing.getState()
  if (ids.has(id)) {
    return
  }
  useMessageEditing.setState({ ids: new Set(ids).add(id) })
}

export const endMessageEdit = (id: string) => {
  const { ids } = useMessageEditing.getState()
  if (!ids.has(id)) {
    return
  }
  const next = new Set(ids)
  next.delete(id)
  useMessageEditing.setState({ ids: next })
}

/** 底部输入框接管焦点时退出所有内联编辑，让键盘正常把输入框抬上来 */
export const stopMessageEdits = () => {
  if (useMessageEditing.getState().ids.size === 0) {
    return
  }
  useMessageEditing.setState({ ids: new Set<string>() })
}

/**
 * 手机端页面跟随视觉视口，键盘弹出后顶栏和输入框仍留在可见区域。
 * 安卓 App 里 MainActivity 会把 WebView 容器直接 resize 到键盘顶部
 * （Capacitor Keyboard 插件同款做法），visualViewport 高度和 WebView 高度一致，
 * 这里设置的是同一个值，不会重复扣减；键盘收起后变量回到整屏高度，
 * 底部导航栏（小白条）区域也能完整覆盖。
 *
 * 编辑已有消息时不跟随键盘：页面锁在键盘弹起前的整屏高度，底部输入框留在原位被键盘盖住，
 * 只把键盘占掉的高度写进 --app-keyboard-cover，交给编辑框滚动避让。
 */
export const useMobileViewport = (enabled: boolean) => {
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const frame = frameRef.current
    const viewport = window.visualViewport
    if (!frame || !viewport) {
      return
    }

    let animationFrame = 0
    let editing = useMessageEditing.getState().ids.size > 0
    // 键盘弹起只会让视口变矮，保留没弹键盘时的最大高度，编辑时用它锁住页面
    let restingHeight = Math.round(viewport.height)
    let restingWidth = Math.round(window.innerWidth)

    const reset = () => {
      frame.style.removeProperty('--app-viewport-height')
      frame.style.removeProperty('--app-viewport-top')
      frame.style.removeProperty('--app-keyboard-cover')
      markKeyboardOpen(false)
    }
    const update = () => {
      // iOS 的 scale 会报成 0.9999 / 1.0001，严格比较会把正常状态误判成缩放
      if (Math.abs(viewport.scale - 1) > 0.01) {
        if (restingHeight > 0) {
          frame.style.setProperty('--app-viewport-height', `${restingHeight}px`)
          frame.style.setProperty('--app-viewport-top', '0px')
        }
        return
      }
      const height = Math.round(viewport.height)
      // 切后台返回或键盘动画中间帧会报 0 / 极小高度，写进去会让页面塌陷
      if (height < 50) {
        return
      }
      const width = Math.round(window.innerWidth)
      if (width !== restingWidth) {
        // 横竖屏切换后旧的最大高度失效，按新视口重新记录
        restingWidth = width
        restingHeight = height
      }
      if (editing) {
        // 编辑已有消息时页面锁在整屏高度，底部留白保持键盘收起前的样子
        markKeyboardOpen(false)
        frame.style.setProperty('--app-viewport-height', `${restingHeight}px`)
        frame.style.setProperty('--app-keyboard-cover', `${Math.max(0, restingHeight - height)}px`)
        return
      }
      // 焦点在输入框且视口明显变矮才算键盘弹起；页面已经贴到键盘顶部，
      // 底部那 34px 的 home indicator 留白要收掉，否则键盘上方会多出一条空白
      markKeyboardOpen(isTextEntry() && restingHeight - height > KEYBOARD_MIN_INSET)
      restingHeight = Math.max(restingHeight, height)
      frame.style.setProperty('--app-viewport-height', `${height}px`)
      frame.style.setProperty('--app-viewport-top', `${Math.round(viewport.offsetTop)}px`)
      frame.style.removeProperty('--app-keyboard-cover')
    }
    const schedule = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }

    const onEditingChange = () => {
      const next = useMessageEditing.getState().ids.size > 0
      if (next === editing) {
        return
      }
      editing = next
      // 立即锁定，避免键盘动画中途才开始停住
      cancelAnimationFrame(animationFrame)
      update()
    }
    const unsubscribe = useMessageEditing.subscribe(onEditingChange)

    update()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    return () => {
      unsubscribe()
      cancelAnimationFrame(animationFrame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      reset()
    }
  }, [enabled])

  return frameRef
}

/** 聚焦后会弹出软键盘的元素 */
const isTextEntry = () => {
  const active = document.activeElement
  return (
    active instanceof HTMLElement &&
    (active.isContentEditable || active.matches('input, textarea, select'))
  )
}

/**
 * 键盘弹起前的整屏高度与当前键盘覆盖高度，供对话列表这类固定在屏幕左右两侧的栏目使用。
 * 键盘弹起时侧栏保持整屏高度，底部设置项留在原位被键盘盖住，列表只按键盘高度留出底部滚动空间；
 * 窗口自身缩放（宽度变化或焦点不在输入框）照常跟随，避免侧栏比窗口还高。
 */
export const useKeyboardInset = () => {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) {
      return
    }
    const root = document.documentElement
    // 只有以触摸为主输入的设备才可能弹软键盘；桌面窗口缩放不能当成键盘
    const coarsePointer = window.matchMedia('(pointer: coarse)')
    let animationFrame = 0
    let blurTimer = 0
    let restHeight = Math.round(viewport.height)
    let restWidth = Math.round(window.innerWidth)
    let keyboardOpen = false

    const update = () => {
      // 双指缩放时会话列表也跟着缩放，不要把缩放后的高度记成整屏高度
      if (Math.abs(viewport.scale - 1) > 0.01) {
        return
      }
      const height = Math.round(viewport.height)
      const width = Math.round(window.innerWidth)
      if (width !== restWidth || height >= restHeight || !coarsePointer.matches) {
        restWidth = width
        restHeight = height
        keyboardOpen = false
      } else if (!keyboardOpen) {
        // 明显变矮且焦点在输入框才当作键盘，手柄缩放窗口不出错
        if (isTextEntry() && restHeight - height > KEYBOARD_MIN_INSET) {
          keyboardOpen = true
        } else {
          restHeight = height
        }
      }
      root.style.setProperty('--app-rest-height', `${restHeight}px`)
      root.style.setProperty('--app-keyboard-inset', `${Math.max(0, restHeight - height)}px`)
    }
    const schedule = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    // 焦点离开后键盘若一直没收起，说明之前的变矮不是键盘，把记录的高度改回当前视口
    const onFocusOut = () => {
      window.clearTimeout(blurTimer)
      blurTimer = window.setTimeout(() => {
        if (!keyboardOpen || isTextEntry()) {
          return
        }
        const height = Math.round(viewport.height)
        if (height < restHeight) {
          keyboardOpen = false
          restHeight = height
          update()
        }
      }, 500)
    }

    update()
    viewport.addEventListener('resize', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('focusin', schedule)
    window.addEventListener('focusout', onFocusOut)
    return () => {
      window.clearTimeout(blurTimer)
      cancelAnimationFrame(animationFrame)
      viewport.removeEventListener('resize', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('focusin', schedule)
      window.removeEventListener('focusout', onFocusOut)
      root.style.removeProperty('--app-rest-height')
      root.style.removeProperty('--app-keyboard-inset')
    }
  }, [])
}

/** 从触摸目标向上找是否存在可滚动的容器；只在 touchstart 时判断一次 */
const isScrollableTarget = (target: EventTarget | null) => {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    const scrollsY =
      /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight
    const scrollsX =
      /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth
    if (scrollsY || scrollsX) {
      return true
    }
  }
  return false
}

/** 阻止移动端整页滚动，保留内部可滚动区域的滚动。 */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    // 每次 touchmove 都遍历祖先并读计算样式会拖慢长列表滚动，这里缓存起手时的判断结果
    let scrollable = false
    const start = (event: TouchEvent) => {
      scrollable = isScrollableTarget(event.target)
    }
    const move = (event: TouchEvent) => {
      if (event.touches.length === 1 && !scrollable) {
        event.preventDefault()
      }
    }
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    return () => {
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
    }
  }, [enabled])
}

/**
 * 禁用 App 内页面缩放。iOS 的 gesture 事件能拦住捏合缩放，
 * 双指 touchmove 作为兜底；网页版不调用，保留浏览器自带缩放。
 */
export const usePreventZoom = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const prevent = (event: Event) => {
      event.preventDefault()
    }
    const preventPinch = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault()
      }
    }
    // iOS 专有的 gesture 事件不在标准 DOM 类型里，只能按字符串注册
    const gestureEvents = ['gesturestart', 'gesturechange', 'gestureend']
    for (const name of gestureEvents) {
      document.addEventListener(name, prevent, { passive: false })
    }
    document.addEventListener('touchmove', preventPinch, { passive: false })
    return () => {
      for (const name of gestureEvents) {
        document.removeEventListener(name, prevent)
      }
      document.removeEventListener('touchmove', preventPinch)
    }
  }, [enabled])
}
