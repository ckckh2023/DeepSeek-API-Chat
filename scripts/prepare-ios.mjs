import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const plistPath = 'ios/App/App/Info.plist'

/** 把一段 plist 片段插到根 </dict> 之前（缩进跟着根节点走） */
const insertPlistLines = (plist, lines) => {
  const before = plist
  plist = plist.replace(
    /([\t ]*)<\/dict>(\r?\n)<\/plist>/,
    (_match, indent, newline) =>
      `${lines.map((line) => `${indent}${line}`).join(newline)}${newline}${indent}</dict>${newline}</plist>`
  )
  if (plist === before) {
    throw new Error('iOS Info.plist: failed to insert keys')
  }
  return plist
}

if (existsSync(plistPath)) {
  let plist = readFileSync(plistPath, 'utf8')
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))

  const parts = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const shortVersion = parts.slice(0, 3).join('.')
  const buildVersion = String((parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0))

  plist = plist.replace(
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${shortVersion}$2`
  )
  plist = plist.replace(
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
    `$1${buildVersion}$2`
  )

  const microphoneKey = 'NSMicrophoneUsageDescription'

  if (!plist.includes(microphoneKey)) {
    plist = insertPlistLines(plist, [
      `<key>${microphoneKey}</key>`,
      '<string>用于语音输入和录音</string>',
    ])
  }

  // 声明支持中文：没有这一个列表，iOS 会把 App 当成「只支持英文」，
  // WKWebView 里长按的拷贝/粘贴菜单、相册与文件选择的系统按钮都会是英文。
  const localizationKey = 'CFBundleLocalizations'

  if (!plist.includes(localizationKey)) {
    plist = insertPlistLines(plist, [
      `<key>${localizationKey}</key>`,
      '<array>',
      '\t<string>zh-Hans</string>',
      '\t<string>zh-Hant</string>',
      '\t<string>en</string>',
      '</array>',
    ])
  }

  writeFileSync(plistPath, plist)

  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `IOS_SHORT_VERSION=${shortVersion}\nIOS_BUILD_VERSION=${buildVersion}\n`
    )
  }
}

// 去掉 WKWebView 键盘上方那条「上一项 / 下一项 / 完成」原生辅助条。
// 应用里只有聊天输入框一个表单控件，这条栏没有用处，只会把输入区顶高。
const appDelegatePath = 'ios/App/App/AppDelegate.swift'

if (existsSync(appDelegatePath)) {
  let appDelegate = readFileSync(appDelegatePath, 'utf8')

  if (!appDelegate.includes('disableWebInputAccessory')) {
    const anchor = /^([\t ]*)\/\/ Override point for customization after application launch\.[\t ]*$/m

    if (!anchor.test(appDelegate)) {
      throw new Error('iOS AppDelegate: failed to find didFinishLaunching anchor')
    }

    appDelegate = appDelegate.replace(anchor, (match, indent) =>
      `${match}\n${indent}disableWebInputAccessory()`
    )

    appDelegate = appDelegate.replace('import Capacitor', 'import Capacitor\nimport ObjectiveC.runtime')

    appDelegate = `${appDelegate.replace(/\s*$/, '')}

/// 把 WKContentView 的 inputAccessoryView 置空，键盘上方就不会再出现
/// 「上一项 / 下一项 / 完成」那条原生辅助栏。iOS 改版后最坏情况是这条栏回来，不影响其它功能。
private func disableWebInputAccessory() {
    guard let cls: AnyClass = NSClassFromString("WKContentView") else { return }
    let selector = #selector(getter: UIResponder.inputAccessoryView)
    guard let method = class_getInstanceMethod(cls, selector) else { return }
    let block: @convention(block) (AnyObject) -> UIView? = { _ in nil }
    method_setImplementation(method, imp_implementationWithBlock(block))
}
`

    writeFileSync(appDelegatePath, appDelegate)
  }
}

const appIconSource = 'assets/icon-ios.png'
const appIconDir = 'ios/App/App/Assets.xcassets/AppIcon.appiconset'

if (existsSync(appIconDir)) {
  if (!existsSync(appIconSource)) {
    throw new Error(`iOS app icon source not found: ${appIconSource}`)
  }

  copyFileSync(appIconSource, `${appIconDir}/AppIcon-512@2x.png`)

  const contentsPath = `${appIconDir}/Contents.json`

  if (!existsSync(contentsPath)) {
    writeFileSync(
      contentsPath,
      `${JSON.stringify(
        {
          images: [
            {
              filename: 'AppIcon-512@2x.png',
              idiom: 'universal',
              platform: 'ios',
              size: '1024x1024',
            },
          ],
          info: { author: 'xcode', version: 1 },
        },
        null,
        2
      )}\n`
    )
  }
} else if (existsSync('ios')) {
  throw new Error(`iOS app icon set not found: ${appIconDir}`)
}
