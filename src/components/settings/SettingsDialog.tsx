import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconAddOutline16,
  IconCopyOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconPluginOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  exportHistoryToSink,
  historyArchiveFileName,
  importHistory,
  type HistoryExportProgress,
} from '../../services/chat/backup.js'
import { ExportProgress } from './ExportProgress.js'
import { isCapacitor, isTauri } from '../../app/platform.js'
import { pushBackHandler } from '../../app/backStack.js'
import { useIsMobile } from '../../app/viewport.js'
import { useAdvancedMode } from '../../services/advancedMode.js'
import { useChatStore, switchDataSpace } from '../../services/chat/store.js'
import { useHiddenHistory, type HiddenHistoryMode } from '../../services/hiddenHistory.js'
import { useBackupQueue } from '../../services/backupQueue.js'
import {
  setChatFontSize,
  setLocale,
  setPluginConfig,
  setPluginEnabled,
  setThemePreference,
  setThinkingCollapse,
  setTtsVoice,
  useSettings,
  type ChatFontSize,
  type ThemePreference,
  type ThinkingCollapse,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { plugins, type PluginPreset, type PromptPlugin } from '../../plugins/index.js'
import { renderProfileSections } from '../../plugins/memory/prompt.js'
import {
  addMemoryNote,
  clearMemory,
  readMemoryProfile,
  readMemoryState,
  removeMemoryNote,
  setMemoryAutoEnabled,
  type MemoryNote,
} from '../../services/memory/store.js'
import { isAutoPaused, requestAutoMemory } from '../../services/memory/scheduler.js'
import { requestManualMemory } from '../../services/memory/run.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { showToast } from '../base/toastState.js'
import { usePresence } from '../base/usePresence.js'
import { ApiKeyConfirm, ApiKeyField, useApiKeyEditor } from './ApiKeyField.js'
import {
  setHistoryImportProgress,
  useHistoryImportProgress,
  type HistoryImportProgress,
} from './historyImportState.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import { ImportDialog } from './ImportDialog.js'
import { SettingsNavSwitch } from './SettingsNavSwitch.js'
import { ImportProgress } from './ImportProgress.js'
import { UpdateCheck } from './UpdateCheck.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色）、「数据管理」（API Key、导入、导出、删除）
 * 与「插件管理」。桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  // 关闭时保留 DOM 播完动画：桌面端淡出，移动端向下划出
  const { mounted, visible } = usePresence(open)
  return mounted ? <SettingsContent state={visible ? 'open' : 'closed'} /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
  {
    value: 'plugins',
    label: 'settingDialogAsidePluginsOptionLabel',
    icon: <IconPluginOutline16 />,
  },
]

const SettingsContent = ({ state }: { state: 'open' | 'closed' }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  const [importOpen, setImportOpen] = useState(false)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  const historyImportProgress = useHistoryImportProgress((state) => state.progress)
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        state={state}
        pullDownToClose
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        {isMobile ? (
          <SettingsNavSwitch items={sections} value={section} onChange={setSection} />
        ) : (
          <div role="tablist" className={styles.navigation}>
            {sections.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={section === item.value}
                className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
                onClick={() => setSection(item.value)}
              >
                {item.icon}
                {t(item.label)}
              </button>
            ))}
          </div>
        )}
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <ChatFontSizeSetting />
              <LocaleSetting />
              <ThinkingCollapseSetting />
              <TtsVoiceSetting />
              <UpdateCheck />
            </>
          ) : section === 'plugins' ? (
            <PluginManagement />
          ) : (
            <>
              <ApiKeyField editor={apiKeyEditor} />
              <ImportHistory
                historyImport={historyImport}
                disabled={historyBusy}
                progress={historyImportProgress}
                onOpen={() => setImportOpen(true)}
              />

              <ExportHistory disabled={historyBusy} />
              <HiddenHistorySetting />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        disabled={historyBusy}
        archiveBusy={historyImport.busy}
        archiveProgress={historyImportProgress}
        archiveStatus={historyImport.status}
        onSelectArchive={historyImport.select}
      />
      {historyImport.file ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/** 思考内容：完全折叠只保留标题；部分折叠展开时限高滚动、历史回复默认收起；不折叠完整展开。 */
const thinkingCollapseOptions: { value: ThinkingCollapse; label: TranslationKey }[] = [
  { value: 'full', label: 'settingsThinkingCollapseFull' },
  { value: 'partial', label: 'settingsThinkingCollapsePartial' },
  { value: 'none', label: 'settingsThinkingCollapseNone' },
]

const ThinkingCollapseSetting = () => {
  const t = useTranslate()
  const thinkingCollapse = useSettings((state) => state.thinkingCollapse)
  return (
    <SettingCell
      label={t('settingsThinkingCollapse')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsThinkingCollapse')}
          value={thinkingCollapse}
          options={thinkingCollapseOptions.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setThinkingCollapse}
        />
      }
    />
  )
}

/** 覆盖导入的二次确认，叠在设置弹窗上 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const cancelRef = useRef(historyImport.cancel)
  cancelRef.current = historyImport.cancel
  // 返回键先关确认弹窗，再关下面的导入弹窗
  useEffect(() => pushBackHandler(() => cancelRef.current()), [])
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={() => void historyImport.confirm()}>
            {t('historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('historyImportConfirmDescription')}</div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey }[] = [
  { value: 'light', label: 'avatarMenuSettingsDialogThemeSelectLightOption' },
  { value: 'dark', label: 'avatarMenuSettingsDialogThemeSelectDarkOption' },
  { value: 'system', label: 'avatarMenuSettingsDialogThemeSelectSystemOption' },
]

/** 主题项：与语言、朗读音色、位置一致，用下拉框选择，未保存时默认跟随系统。 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  return (
    <SettingCell
      label={t('avatarMenuSettingsDialogThemeItemLabel')}
      status={null}
      action={
        <Select
          ariaLabel={t('avatarMenuSettingsDialogThemeItemLabel')}
          value={themePreference}
          options={themeOptions.map((option) => ({ value: option.value, label: t(option.label) }))}
          onChange={setThemePreference}
        />
      }
    />
  )
}

/** 对话与列表字体大小：显示在通用设置，同时改对话消息区与对话列表字号，不影响其他界面 */
const chatFontSizeOptions: { value: ChatFontSize; label: TranslationKey }[] = [
  { value: 'small', label: 'settingsChatFontSizeSmall' },
  { value: 'standard', label: 'settingsChatFontSizeStandard' },
  { value: 'large', label: 'settingsChatFontSizeLarge' },
  { value: 'xlarge', label: 'settingsChatFontSizeXLarge' },
]

const ChatFontSizeSetting = () => {
  const t = useTranslate()
  const chatFontSize = useSettings((state) => state.chatFontSize)
  return (
    <SettingCell
      label={t('settingsChatFontSize')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsChatFontSize')}
          value={chatFontSize}
          options={chatFontSizeOptions.map((option) => ({
            value: option.value,
            label: t(option.label),
          }))}
          onChange={setChatFontSize}
        />
      }
    />
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

/** 插件正文的字符上限，只限制 UI 输入 */
const PLUGIN_PROMPT_LIMIT = 4000

const readConfigText = (config: Record<string, unknown> | undefined): string =>
  typeof config?.text === 'string' ? config.text : ''

/**
 * 插件文本弹窗的骨架：Modal + 可选预设按钮 + textarea + 计数器 + 提示。
 *
 * 取值与落盘由调用方给：正文弹窗落进 config.text，「记忆」落进自己的 localStorage 键。
 * 骨架只负责一致性（同样的边框、计数器、提示位置），不假设正文存在哪。
 */
const PluginTextDialog = ({
  open,
  title,
  hint,
  placeholder,
  presets,
  limit = PLUGIN_PROMPT_LIMIT,
  readText,
  onSave,
  onClose,
}: {
  open: boolean
  title: string
  hint: string
  placeholder?: string
  presets?: readonly PluginPreset[]
  limit?: number
  readText: () => string
  onSave: (text: string) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  // 进 ref 而不是进依赖数组：readText 每次渲染都是新闭包，直接进依赖会让用户打字被覆盖
  const readRef = useRef(readText)
  readRef.current = readText
  const [text, setText] = useState(() => readRef.current())
  useEffect(() => {
    if (open) {
      setText(readRef.current())
    }
  }, [open])
  if (!mounted) {
    return null
  }
  return (
    <Modal
      title={title}
      className={styles.pluginDialog}
      mainClassName={styles.pluginDialogMain}
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            size="m"
            onClick={() => {
              onSave(text)
              onClose()
            }}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      {presets && presets.length > 0 ? (
        <div className={styles.pluginPresets}>
          <div className={styles.pluginPresetsLabel}>{t('pluginPresetLabel')}</div>
          <div className={styles.pluginPresetList}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={styles.pluginPresetButton}
                onClick={() => setText(preset.text)}
              >
                {t(preset.labelKey as TranslationKey)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <textarea
        className={styles.pluginTextarea}
        value={text}
        maxLength={limit}
        placeholder={placeholder}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      <div className={styles.pluginCounter}>
        {t('pluginCustomInstructionsCounter', {
          count: text.length,
          limit,
        })}
      </div>
      <div className={styles.pluginHint}>{hint}</div>
    </Modal>
  )
}

/**
 * 编辑插件正文：正文来自 config.text，没改过时显示 defaultText。
 * 保存时若与内置正文一致就写入空字符串，让插件继续回退到内置正文，避免固化旧版本。
 */
const PluginPromptDialog = ({
  open,
  name,
  title,
  builtin,
  initialText,
  hint,
  placeholder,
  presets,
  onClose,
}: {
  open: boolean
  name: string
  title: string
  builtin: string
  initialText: string
  hint: string
  placeholder?: string
  presets?: readonly PluginPreset[]
  onClose: () => void
}) => {
  const builtinText = builtin.trim()
  return (
    <PluginTextDialog
      open={open}
      title={title}
      hint={hint}
      placeholder={placeholder}
      presets={presets}
      readText={() => initialText}
      onSave={(text) => {
        const trimmed = text.slice(0, PLUGIN_PROMPT_LIMIT).trim()
        setPluginConfig(name, { text: trimmed === builtinText ? '' : trimmed })
      }}
      onClose={onClose}
    />
  )
}

/**
 * 手动整理被挡住时的提示。`busy` 不算错误：自动整理正跑着，等它跑完就自然好了。
 */
const BLOCKED_TOAST: Record<
  'no-key' | 'no-session' | 'busy' | 'unexpected',
  { readonly key: TranslationKey; readonly type?: 'error' }
> = {
  'no-key': { key: 'pluginMemoryDeriveNoKey', type: 'error' },
  'no-session': { key: 'pluginMemoryNoSession', type: 'error' },
  // 自动整理正跑着：不是错误，等它跑完就好
  busy: { key: 'pluginMemoryDeriving' },
  unexpected: { key: 'pluginMemoryDeriveFailed', type: 'error' },
}

/**
 * 添加便条的二级弹窗：单行输入，确认后交给 addNote。
 * 返回键只关这一层（后注册的优先），档案弹窗在它下面。
 */
const MemoryNoteDialog = ({
  open,
  onAdd,
  onClose,
}: {
  open: boolean
  onAdd: (text: string) => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const [text, setText] = useState('')
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (open) {
      setText('')
    }
  }, [open])
  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => closeRef.current())
  }, [mounted])

  if (!mounted) {
    return null
  }
  return (
    <Modal
      title={t('pluginMemoryNoteAdd')}
      className={styles.pluginDialog}
      mainClassName={styles.pluginDialogMain}
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            size="m"
            disabled={!text.trim()}
            onClick={() => {
              onAdd(text)
              onClose()
            }}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      <textarea
        className={styles.pluginTextarea}
        value={text}
        placeholder={t('pluginMemoryNotePlaceholder')}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
    </Modal>
  )
}

/** 清空全部记忆的二次确认，复用导入确认的弹窗样式 */
const MemoryClearConfirm = ({
  open,
  onConfirm,
  onClose,
}: {
  open: boolean
  onConfirm: () => void
  onClose: () => void
}) => {
  const t = useTranslate()
  const { mounted, visible } = usePresence(open)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => closeRef.current())
  }, [mounted])

  if (!mounted) {
    return null
  }
  return (
    <Modal
      title={t('pluginMemoryClearConfirmTitle')}
      className={styles.importConfirm}
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="dangerOutlined" size="m" onClick={onConfirm}>
            {t('pluginMemoryClearConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>{t('pluginMemoryClearConfirmDescription')}</div>
    </Modal>
  )
}

/**
 * 记忆档案弹窗：**只读**档案 + 便条列表 + 三个动作。
 *
 * spec《便条》的立场：用户不能直接改档案。直接改会和下次重写打架 —— 用户改掉的一句，
 * 模型重写时可能又丢回去，而且用户会以为自己改成功了。便条是**输入**不是**输出**，
 * 不会丢：下次整理必须逐条回应。
 *
 * 三个动作：复制档案（只读视图的顺手操作，不构成写入路径）、立即整理、清空全部记忆。
 * 整理进行中把按钮置灰，连点第二次直接返回，不并发两个整理。
 */
const MemoryProfileDialog = ({
  open,
  title,
  hint,
  onClose,
}: {
  open: boolean
  title: string
  hint?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  // 不再订阅 activeId：调度器在真正发起整理的那一刻现取「当前会话」，切了也不会打错
  const [busy, setBusy] = useState(false)
  const [profileText, setProfileText] = useState('')
  const [notes, setNotes] = useState<readonly MemoryNote[]>([])
  const [noteOpen, setNoteOpen] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [autoEnabled, setAutoEnabled] = useState(true)
  const [failures, setFailures] = useState(0)
  const { mounted, visible } = usePresence(open)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const reload = () => {
    const memory = readMemoryState()
    setProfileText(renderProfileSections(readMemoryProfile()))
    setNotes(memory.notes)
    setAutoEnabled(memory.autoEnabled)
    setFailures(memory.failures)
  }
  useEffect(() => {
    if (open) {
      reload()
    } else {
      setNoteOpen(false)
      setClearConfirmOpen(false)
    }
  }, [open])

  const derive = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    try {
      const result = await requestManualMemory()
      if (result.blocked !== undefined) {
        showToast(BLOCKED_TOAST[result.blocked])
      } else if (result.outcome.status === 'updated') {
        showToast({ key: 'pluginMemoryDerived' })
      } else if (result.outcome.status === 'failed') {
        showToast({ key: 'pluginMemoryDeriveFailed', type: 'error' })
      } else {
        showToast({ key: 'pluginMemoryNothingPending' })
      }
      // 手动整理成功会清零失败计数，退避随之解除 —— 重读一次让提示立刻消失
      reload()
    } finally {
      setBusy(false)
    }
  }

  const addNote = (text: string) => {
    if (!addMemoryNote(text, Date.now())) {
      return
    }
    reload()
    showToast({ key: 'pluginMemoryNoteAdded' })
  }

  // 供二级弹窗使用：返回键先关便条弹窗，再关档案弹窗
  useEffect(() => {
    if (!mounted) {
      return
    }
    return pushBackHandler(() => closeRef.current())
  }, [mounted])

  if (!mounted) {
    return null
  }
  return (
    <Modal
      title={title}
      className={styles.pluginDialog}
      mainClassName={styles.pluginDialogMain}
      state={visible ? 'open' : 'closed'}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" disabled={busy} onClick={() => void derive()}>
            {t(busy ? 'pluginMemoryDeriving' : 'pluginMemoryDeriveNow')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={busy}
            onClick={() => setClearConfirmOpen(true)}
          >
            {t('pluginMemoryClear')}
          </Button>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('close')}
          </Button>
        </>
      }
    >
      <div className={clsx(styles.pluginSectionTitle, styles.pluginSectionTitleRow)}>
        <span>{t('pluginMemoryProfileTitle')}</span>
        <div className={styles.memoryAutoControl}>
          <span>{t('pluginMemoryAutoLabel')}</span>
          <Switch
            aria-label={t('pluginMemoryAutoLabel')}
            checked={autoEnabled}
            onChange={(enabled) => {
              setMemoryAutoEnabled(enabled)
              setAutoEnabled(enabled)
              // 刚打开时立刻试一次：不用等到攒够 8 轮或等满 5 分钟空闲
              if (enabled) {
                requestAutoMemory('opened')
              }
            }}
          />
        </div>
      </div>
      <div className={styles.memoryProfileWrap}>
        <div
          className={clsx(
            styles.memoryProfile,
            profileText ? styles.memoryProfileWithCopy : styles.memoryProfileEmpty
          )}
          tabIndex={profileText ? 0 : undefined}
        >
          {profileText || t('pluginMemoryProfileEmpty')}
        </div>
        {profileText ? (
          <IconButton
            className={styles.memoryProfileCopy}
            size="xs"
            icon={<IconCopyOutline16 />}
            tooltip={t('pluginMemoryCopyProfile')}
            onClick={() => {
              void copyText(profileText).then((ok) => {
                showToast(ok ? { key: 'copied' } : { key: 'copyFailed', type: 'error' })
              })
            }}
          />
        ) : null}
      </div>
      <div className={styles.memoryIntro}>{t('pluginMemoryProfileIntro')}</div>
      <div className={clsx(styles.pluginSectionTitle, styles.pluginSectionTitleRow)}>
        <span>{t('pluginMemoryNotesTitle')}</span>
        <div className={styles.memoryNoteAdd}>
          <span>{t('pluginMemoryNoteAdd')}</span>
          <IconButton
            size="xs"
            icon={<IconAddOutline16 />}
            tooltip={t('pluginMemoryNoteAdd')}
            onClick={() => setNoteOpen(true)}
          />
        </div>
      </div>
      {notes.length > 0 ? (
        <ul className={styles.memoryNotes}>
          {notes.map((note) => (
            <li key={note.id} className={styles.memoryNote}>
              <span className={styles.memoryNoteText}>
                {note.reply ? (
                  <span className={styles.memoryNoteRead}>{t('pluginMemoryNoteRead')}</span>
                ) : null}
                <span>{note.text}</span>
              </span>
              <IconButton
                className={styles.memoryNoteDelete}
                size="xs"
                icon={<IconTrashOutline16 />}
                tooltip={t('pluginMemoryNoteDelete')}
                onClick={() => {
                  removeMemoryNote(note.id)
                  reload()
                }}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className={clsx(styles.memoryProfile, styles.memoryProfileEmpty)}>
          {t('pluginMemoryNotesEmpty')}
        </div>
      )}
      <div className={styles.memoryIntro}>{t('pluginMemoryNotesIntro')}</div>
      {isAutoPaused(failures) ? (
        <div className={styles.pluginDescription}>{t('pluginMemoryAutoPaused')}</div>
      ) : null}
      <MemoryNoteDialog open={noteOpen} onAdd={addNote} onClose={() => setNoteOpen(false)} />
      <MemoryClearConfirm
        open={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        onConfirm={() => {
          clearMemory()
          reload()
          showToast({ key: 'pluginMemoryCleared' })
          setClearConfirmOpen(false)
        }}
      />
      {hint ? <div className={styles.pluginHint}>{hint}</div> : null}
    </Modal>
  )
}

/**
 * 一个插件行：展示文案来自插件的 ui 元数据，开关与正文写在 pluginSettings 里。
 * 设置页不按插件名写死条目，新增插件只改插件定义与注册表。
 */
const PluginToggleCell = ({ plugin }: { plugin: PromptPlugin }) => {
  const t = useTranslate()
  const state = useSettings((settings) => settings.pluginSettings[plugin.name])
  const [editorOpen, setEditorOpen] = useState(false)
  const labelKey = (plugin.ui?.labelKey ?? plugin.name) as TranslationKey
  const label = t(labelKey)
  const descriptionKey = plugin.ui?.descriptionKey as TranslationKey | undefined
  const hintKey = (plugin.ui?.hintKey ?? 'pluginPromptHintBuiltin') as TranslationKey
  const placeholderKey = plugin.ui?.placeholderKey as TranslationKey | undefined
  const builtin = plugin.defaultText ?? ''
  const initialText = readConfigText(state?.config) || builtin
  const editable = plugin.ui?.editable === true
  const profileEditor = plugin.ui?.editor === 'profile'
  const tooltipKey = (plugin.ui?.tooltipKey ?? 'pluginPromptEditNamed') as TranslationKey
  const [profileOpen, setProfileOpen] = useState(false)
  /**
   * 自动整理被暂停时在插件行上直说。
   *
   * spec 要求「在设置页提示」，只藏在档案弹窗里等于没说：不点进去的人不知道自己被暂停了。
   * 这里在渲染时读一次本地状态（不订阅）：设置页每次打开都会重新挂载，够新；
   * 停在设置页期间正好被暂停的概率很低，那一点旧值不值得为它引入一套订阅。
   */
  const showPaused = profileEditor && isAutoPaused(readMemoryState().failures)
  return (
    <>
      <SettingCell
        label={label}
        description={
          showPaused ? t('pluginMemoryAutoPaused') : descriptionKey ? t(descriptionKey) : null
        }
        status={null}
        action={
          <div className={styles.pluginActions}>
            {editable || profileEditor ? (
              <IconButton
                size="xs"
                icon={<IconEditOutline16 />}
                tooltip={t(tooltipKey, { name: label })}
                onClick={() => (profileEditor ? setProfileOpen(true) : setEditorOpen(true))}
              />
            ) : null}
            <Switch
              aria-label={label}
              checked={state?.enabled === true}
              onChange={(enabled) => setPluginEnabled(plugin.name, enabled)}
            />
          </div>
        }
      />
      {editable && !profileEditor ? (
        <PluginPromptDialog
          open={editorOpen}
          name={plugin.name}
          title={t('pluginPromptDialogTitle', { name: label })}
          builtin={builtin}
          initialText={initialText}
          hint={t(hintKey)}
          placeholder={placeholderKey ? t(placeholderKey) : undefined}
          presets={plugin.ui?.presets}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
      {profileEditor ? (
        <MemoryProfileDialog
          open={profileOpen}
          title={t('pluginPromptDialogTitle', { name: label })}
          hint={plugin.ui?.hintKey ? t(hintKey) : undefined}
          onClose={() => setProfileOpen(false)}
        />
      ) : null}
    </>
  )
}

/** 插件管理：按 community 分区；非官方插件只在高级模式开启时展示，条目全部来自注册表。 */
const PluginManagement = () => {
  const t = useTranslate()
  const advancedEnabled = useAdvancedMode((state) => state.enabled)
  const builtinPlugins = plugins.filter((plugin) => plugin.community !== true)
  const communityPlugins = plugins.filter((plugin) => plugin.community === true)
  return (
    <div className={styles.pluginList}>
      <section className={styles.pluginSection}>
        <div className={styles.pluginSectionTitle}>{t('pluginSectionBuiltin')}</div>
        {builtinPlugins.map((plugin) => (
          <PluginToggleCell key={plugin.name} plugin={plugin} />
        ))}
      </section>
      {advancedEnabled && communityPlugins.length > 0 ? (
        <section className={styles.pluginSection}>
          <div className={styles.pluginSectionTitle}>{t('pluginSectionCommunity')}</div>
          {communityPlugins.map((plugin) => (
            <PluginToggleCell key={plugin.name} plugin={plugin} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: ReactNode
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先提示覆盖；确认后才检查文件并执行导入，任何错误都提示导入失败。 */
const useHistoryImport = () => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus(null)
    // 解析 ZIP 中央目录期间没有字节进度，先显示不确定的「正在解析文件」。
    setHistoryImportProgress({ phase: 'parsing' })
    try {
      const count = await importHistory(file, (ratio) => {
        // 进度条只显示整数百分比，避免每个解压分块都触发渲染。
        const percent = Math.round(ratio * 100)
        const current = useHistoryImportProgress.getState().progress
        if (current?.phase !== 'importing' || current.percent !== percent) {
          setHistoryImportProgress({ phase: 'importing', percent })
        }
      })
      setStatus({ key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } })
    } catch {
      setStatus({ key: 'historyImportFailed', error: true })
    } finally {
      importing.current = false
      setBusy(false)
      setHistoryImportProgress(null)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 导入入口：打开导入弹窗；ZIP 仍是覆盖式导入。 */
const ImportHistory = ({
  historyImport,
  disabled,
  progress,
  onOpen,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
  progress: HistoryImportProgress | null
  onOpen: () => void
}) => {
  const t = useTranslate()

  return (
    <SettingCell
      label={t('importEntry')}
      description={
        progress === null ? t('importEntryDescription') : <ImportProgress progress={progress} />
      }
      status={historyImport.status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={clsx(styles.cellButton, styles.uploadButton)}
          disabled={disabled}
          onClick={onOpen}
        >
          <IconUploadOutline14 />
          {t('importHistoryAction')}
        </Button>
      }
    />
  )
}



/** 隐藏历史对话：仅高级模式显示入口，关闭后选择继续在列表与数据库层生效。 */
const HiddenHistorySetting = () => {
  const t = useTranslate()
  const advancedEnabled = useAdvancedMode((state) => state.enabled)
  const mode = useHiddenHistory((state) => state.mode)
  const importing = useChatStore((state) => state.importingHistory)
  const streaming = useChatStore((state) => Object.keys(state.streaming).length > 0)
  const backupPending = useBackupQueue((state) => state.pending > 0)
  const [switching, setSwitching] = useState(false)
  const busy = importing || streaming || backupPending || switching

  if (!advancedEnabled) {
    return null
  }

  const change = async (next: HiddenHistoryMode) => {
    if (next === mode || busy) {
      return
    }
    setSwitching(true)
    try {
      const switched = await switchDataSpace(next)
      if (!switched) {
        showToast({ key: 'hiddenHistoryBusy', type: 'error' })
        return
      }
      if ((next === 'all') !== (mode === 'all')) {
        showToast({
          key: next === 'all' ? 'hiddenHistoryPublicSpace' : 'hiddenHistoryPrivateSpace',
        })
      }
    } catch {
      showToast({ key: 'hiddenHistorySwitchFailed', type: 'error' })
    } finally {
      setSwitching(false)
    }
  }

  return (
    <SettingCell
      label={t('hiddenHistoryLabel')}
      description={t('hiddenHistoryDescription')}
      status={null}
      action={
        <div className={styles.selectGuard}>
          <Select
            value={mode}
            options={[
              { value: 'off', label: t('hiddenHistoryOff') },
              { value: 'pinned', label: t('hiddenHistoryPinned') },
              { value: 'all', label: t('hiddenHistoryAll') },
            ]}
            onChange={(next) => void change(next)}
            disabled={busy}
            ariaLabel={t('hiddenHistoryLabel')}
          />
          {busy ? (
            <button
              type="button"
              className={styles.selectGuardHit}
              aria-label={t('hiddenHistoryBusy')}
              onClick={() => showToast({ key: 'hiddenHistoryBusy', type: 'error' })}
            />
          ) : null}
        </div>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [progress, setProgress] = useState<HistoryExportProgress | null>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      if (isCapacitor()) {
        // 移动端边生成边写文件：内存里只保留当前会话与一块写缓冲
        const name = historyArchiveFileName()
        const { createArchiveFileWriter, commitArchiveFile } = await import(
          '../../services/chat/history/exportFile.js'
        )
        setProgress({ phase: 'writing', percent: 0 })
        const writer = await createArchiveFileWriter(name)
        const count = await exportHistoryToSink(setProgress, writer.push)
        await writer.finish()
        setProgress({ phase: 'saving' })
        const result = await commitArchiveFile(name)
        if (!result.savedToDocuments) {
          // 个别系统不允许直接写公共目录，退回缓存文件交给系统分享面板保存
          const uri = result.uri
          const { Share } = await import('@capacitor/share')
          try {
            await Share.share({
              title: name,
              files: [uri.startsWith('file:') ? uri : `file://${uri}`],
              dialogTitle: t('historyExportShare'),
            })
          } catch (error) {
            // 用户在系统分享面板取消，不算导出失败。
            if (/cancel/i.test(String((error as Error | undefined)?.message ?? error))) {
              return
            }
            throw error
          }
        }
        setStatus(
          result.savedToDocuments
            ? { key: 'historyExportedDocuments', params: { count } }
            : { key: count === 1 ? 'historyExportedOne' : 'historyExported', params: { count } }
        )
        return
      }
      setProgress({ phase: 'collecting', done: 0, total: 0 })
      const { name, blob, count } = await exportHistory(setProgress)
      // 打包完成后进入写文件/分享阶段，进度条转为「正在保存」
      setProgress({ phase: 'saving' })
      if (isTauri()) {
        const [{ save }, { writeFile }] = await Promise.all([
          import('@tauri-apps/plugin-dialog'),
          import('@tauri-apps/plugin-fs'),
        ])
        const path = await save({
          defaultPath: name,
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        })
        if (!path) {
          return
        }
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()))
      } else {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = name
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      setStatus({ key: count === 1 ? 'historyExportedOne' : 'historyExported', params: { count } })
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <>
      <SettingCell
        label={t('exportAllLabel')}
        description={t('historyExportDescription')}
        status={status}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={disabled || busy || empty}
            onClick={() => void onExport()}
          >
            <IconDownloadOutline16 />
            {t('exportAllDownload')}
          </Button>
        }
      />
      {progress ? (
        <div className={styles.exportProgress}>
          <ExportProgress progress={progress} />
        </div>
      ) : null}
    </>
  )
}
