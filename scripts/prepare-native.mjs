import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const androidManifest = 'android/app/src/main/AndroidManifest.xml'
// RECORD_AUDIO：麦克风录音；MODIFY_AUDIO_SETTINGS：Capacitor 处理 WebView 的
// AUDIO_CAPTURE 权限请求时会一并申请，缺了它 request.grant 永远不会发生，
// getUserMedia 会一直报 NotAllowedError（即使系统设置里已允许麦克风）。
const androidPermissions = [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
]

if (existsSync(androidManifest)) {
  let source = readFileSync(androidManifest, 'utf8')
  for (const permission of androidPermissions) {
    if (source.includes(permission)) {
      continue
    }
    source = source.replace(
      /(\s*)<application/,
      (_match, whitespace) => `${whitespace}<uses-permission android:name="${permission}" />${whitespace}<application`
    )
  }
  writeFileSync(androidManifest, source)
}

const androidIcons = 'src-tauri/icons/android'
const androidRes = 'android/app/src/main/res'

if (existsSync(androidIcons) && existsSync(androidRes)) {
  cpSync(androidIcons, androidRes, { recursive: true })
}

// 全面屏适配：声明应用自己处理状态栏与手势条，并把真实安全区交给页面。
// WebView 的 env(safe-area-inset-*) 在安卓上大多返回 0（尤其是底部导航栏），
// 所以由原生读出 WindowInsets，通过 SystemBars 接口和 window.__applySystemInsets 下发。
const mainActivitySource = (packageName) => `package ${packageName};

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.annotation.NonNull;
import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 全面屏适配：状态栏与导航栏全透明、页面铺满整屏，
 * 安全区尺寸由页面自己读取，页面底部抬高、顶部压低。
 */
public class MainActivity extends BridgeActivity {

  private int safeTop = 0;
  private int safeBottom = 0;
  private int pageSafeBottom = 0;
  private View contentChild;
  private FrameLayout.LayoutParams contentChildParams;
  private int usableHeightPrevious = 0;
  private final Rect visibleRect = new Rect();
  /** 系统文档选择器（SAF）的请求码 */
  private static final int REQUEST_PICK_DOCUMENTS = 0x4d31;
  /** 系统「保存到」对话框（SAF 创建文档）的请求码 */
  private static final int REQUEST_SAVE_DOCUMENT = 0x4d32;
  /** 原生拍照（系统相机）的请求码 */
  private static final int REQUEST_TAKE_PHOTO = 0x4d33;
  /** 选中的文件先复制到应用缓存，页面读成 Blob 后立即删掉 */
  private static final String ATTACHMENT_CACHE_DIR = "attachments";
  /** 导出时待复制的缓存 ZIP 路径，用户选定保存位置后由它复制过去 */
  private String pendingExportPath = null;
  /** 拍照输出到缓存的文件路径，拍完回传页面 */
  private String pendingPhotoPath = null;

  @Override
  @SuppressWarnings("deprecation")
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    Window window = getWindow();
    WindowCompat.setDecorFitsSystemWindows(window, false);
    window.setStatusBarColor(Color.TRANSPARENT);
    window.setNavigationBarColor(Color.TRANSPARENT);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      WindowManager.LayoutParams attributes = window.getAttributes();
      attributes.layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
      window.setAttributes(attributes);
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      // 去掉手势条后面的半透明遮罩，页面底色才能连成一片
      window.setStatusBarContrastEnforced(false);
      window.setNavigationBarContrastEnforced(false);
    }
    // 不要声明 adjustResize：全屏（decorFitsSystemWindows=false）下它会被部分 ROM
    // 当成“系统自己处理键盘”，既不 resize WebView 也不派发 ime insets。
    // 键盘改由下面手动 resize WebView 容器（Capacitor Keyboard 插件同款做法）。

    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView != null) {
      webView.addJavascriptInterface(new SystemBars(), "SystemBars");
      webView.getSettings().setSupportZoom(false);
      webView.getSettings().setBuiltInZoomControls(false);
      webView.getSettings().setDisplayZoomControls(false);
      // 跟随系统「字体大小」；WebView 自己默认固定在 100%
      webView
          .getSettings()
          .setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
      // 首次布局时页面还没就绪，补发一次
      webView.postDelayed(this::dispatchLayout, 1000);
    }

    FrameLayout content = (FrameLayout) window.getDecorView().findViewById(android.R.id.content);
    contentChild = content.getChildAt(0);
    if (contentChild != null) {
      contentChildParams = (FrameLayout.LayoutParams) contentChild.getLayoutParams();
      // 老系统拿不到 ime insets，靠可见区域变化兜底（Capacitor Keyboard 插件同款思路）
      contentChild.getViewTreeObserver().addOnGlobalLayoutListener(this::refreshKeyboard);
    }

    ViewCompat.setOnApplyWindowInsetsListener(
        content,
        (view, insets) -> {
          safeTop =
              toCssPixels(
                  insets
                      .getInsets(
                          WindowInsetsCompat.Type.systemBars()
                              | WindowInsetsCompat.Type.displayCutout())
                      .top);
          safeBottom = toCssPixels(insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom);
          refreshKeyboard();
          view.onApplyWindowInsets(insets.toWindowInsets());
          return insets;
        });

    ViewCompat.setWindowInsetsAnimationCallback(
        content.getRootView(),
        new WindowInsetsAnimationCompat.Callback(
            WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_STOP) {
          @NonNull
          @Override
          public WindowInsetsCompat onProgress(
              @NonNull WindowInsetsCompat insets,
              @NonNull List<WindowInsetsAnimationCompat> runningAnimations) {
            return insets;
          }

          @NonNull
          @Override
          public WindowInsetsAnimationCompat.BoundsCompat onStart(
              @NonNull WindowInsetsAnimationCompat animation,
              @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds) {
            refreshKeyboard();
            return super.onStart(animation, bounds);
          }

          @Override
          public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
            super.onEnd(animation);
            refreshKeyboard();
          }
        });
  }

  /** BridgeActivity 里的 onResume 是 public，重写时不能收窄访问级别。 */
  @Override
  public void onResume() {
    super.onResume();
    // 从后台回来时视口可能变了（分屏、旋转），重新对齐一次
    refreshKeyboard();
    dispatchLayout();
  }

  /**
   * 系统返回键 / 返回手势：先让页面按「设置 → 搜索结果 → 对话列表」逐层关闭，
   * 页面返回 false（已经回到主界面）才退出应用。
   */
  @Override
  @SuppressWarnings("deprecation")
  public void onBackPressed() {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      super.onBackPressed();
      return;
    }
    webView.evaluateJavascript(
        "window.__handleSystemBack?window.__handleSystemBack():false",
        handled -> {
          if (!"true".equals(handled)) {
            runOnUiThread(this::exitApp);
          }
        });
  }

  private void exitApp() {
    super.onBackPressed();
  }

  /**
   * 文件入口走 SAF：系统文档选择器把用户主动选中的 URI 单次授权给应用，
   * 不需要存储权限，也不会触发厂商的「读取文件」拦截。
   */
  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQUEST_TAKE_PHOTO) {
      finishNativePhoto(resultCode);
      return;
    }
    if (requestCode == REQUEST_SAVE_DOCUMENT) {
      String source = pendingExportPath;
      pendingExportPath = null;
      if (resultCode != RESULT_OK || data == null || data.getData() == null || source == null) {
        notifyDocumentSaveCancelled();
        return;
      }
      copyExportToUri(source, data.getData());
      return;
    }
    if (requestCode != REQUEST_PICK_DOCUMENTS) {
      super.onActivityResult(requestCode, resultCode, data);
      return;
    }
    if (resultCode != RESULT_OK || data == null) {
      // 用户取消：回空数组，页面不会触发回退
      notifyDocumentsPicked("[]");
      return;
    }
    ArrayList<Uri> uris = collectDocumentUris(data);
    new Thread(
            () -> {
              String json = copyDocumentsToCache(uris).toString();
              runOnUiThread(() -> notifyDocumentsPicked(json));
            })
        .start();
  }

  private ArrayList<Uri> collectDocumentUris(Intent data) {
    ArrayList<Uri> uris = new ArrayList<>();
    ClipData clip = data.getClipData();
    if (clip != null) {
      for (int index = 0; index < clip.getItemCount(); index++) {
        Uri uri = clip.getItemAt(index).getUri();
        if (uri != null) {
          uris.add(uri);
        }
      }
      return uris;
    }
    if (data.getData() != null) {
      uris.add(data.getData());
    }
    return uris;
  }

  /** 复制到应用缓存，页面用 convertFileSrc 读成 Blob 后立即删掉副本 */
  private JSONArray copyDocumentsToCache(ArrayList<Uri> uris) {
    JSONArray items = new JSONArray();
    File dir = new File(getCacheDir(), ATTACHMENT_CACHE_DIR);
    if (!dir.exists() && !dir.mkdirs()) {
      return items;
    }
    for (Uri uri : uris) {
      InputStream input = null;
      try {
        String name = queryDisplayName(uri);
        String mime = getContentResolver().getType(uri);
        File out = new File(dir, System.currentTimeMillis() + "-" + sanitizeFileName(name));
        input = getContentResolver().openInputStream(uri);
        if (input == null) {
          continue;
        }
        try (OutputStream output = new FileOutputStream(out)) {
          byte[] buffer = new byte[64 * 1024];
          int read;
          while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
          }
        }
        JSONObject item = new JSONObject();
        item.put("name", name);
        item.put("mime", mime == null ? "" : mime);
        item.put("size", out.length());
        item.put("path", out.getAbsolutePath());
        items.put(item);
      } catch (Exception ignored) {
        // 单个文件读不出来不影响其它已选文件
      } finally {
        if (input != null) {
          try {
            input.close();
          } catch (Exception ignored) {
            // 关闭失败可以忽略
          }
        }
      }
    }
    return items;
  }

  /** 用户选好保存位置后，把缓存里的 ZIP 原样复制过去（全程在原生层，不经过页面 base64） */
  private void copyExportToUri(String sourcePath, Uri target) {
    new Thread(
            () -> {
              boolean ok = true;
              Uri source = Uri.parse(sourcePath);
              String path = "file".equals(source.getScheme()) ? source.getPath() : sourcePath;
              try (InputStream input = new FileInputStream(new File(path));
                  OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
                if (output == null) {
                  throw new IllegalStateException("No output stream for export target");
                }
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                  output.write(buffer, 0, read);
                }
              } catch (Exception error) {
                ok = false;
              }
              final boolean saved = ok;
              runOnUiThread(
                  () -> {
                    if (saved) {
                      notifyDocumentSaved();
                    } else {
                      notifyDocumentSaveFailed();
                    }
                  });
            })
        .start();
  }

  private String queryDisplayName(Uri uri) {
    String name = uri.getLastPathSegment();
    try (Cursor cursor =
        getContentResolver()
            .query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) {
        int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (index >= 0) {
          String value = cursor.getString(index);
          if (value != null && !value.isEmpty()) {
            name = value;
          }
        }
      }
    } catch (Exception ignored) {
      // 部分 provider 不支持查询，退回 URI 末段
    }
    return name == null || name.isEmpty() ? "attachment" : name;
  }

  /** 文件名只用于缓存目录，去掉路径分隔符与 .. 防止越界 */
  private String sanitizeFileName(String name) {
    return name.replace("/", "_").replace("\\\\", "_").replace("..", "_");
  }

  /** 物理像素换算成页面用的 CSS 像素（等于 dp）。 */
  private int toCssPixels(int pixels) {
    return Math.round(pixels / getResources().getDisplayMetrics().density);
  }

  private int dpToPx(int dp) {
    return Math.round(dp * getResources().getDisplayMetrics().density);
  }

  /**
   * 全屏下 Android 不会自动 resize WebView（Capacitor Keyboard 插件注释里的已知 bug），
   * 这里手动把 WebView 容器的高度改成键盘顶部；键盘收起时恢复 MATCH_PARENT。
   * 页面因此不需要拿 100dvh 或 insets 做任何减法，内容位置和 WebView 完全一致。
   */
  private void refreshKeyboard() {
    if (contentChild == null || contentChildParams == null) {
      return;
    }
    contentChild.getWindowVisibleDisplayFrame(visibleRect);
    int rootHeight = contentChild.getRootView().getHeight();
    int covered = Math.max(0, rootHeight - visibleRect.bottom);
    // 导航栏、手势条只有几十 dp，忽略它们，只把真正的键盘当作键盘
    boolean keyboardShown = covered >= dpToPx(120);
    int nextHeight = keyboardShown ? visibleRect.bottom : FrameLayout.LayoutParams.MATCH_PARENT;
    int nextSafeBottom = keyboardShown ? 0 : safeBottom;
    if (nextHeight == usableHeightPrevious && nextSafeBottom == pageSafeBottom) {
      return;
    }
    usableHeightPrevious = nextHeight;
    pageSafeBottom = nextSafeBottom;
    contentChildParams.height = nextHeight;
    contentChild.requestLayout();
    dispatchLayout();
  }

  private void dispatchLayout() {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      return;
    }
    int fontWeightAdjustment = 0;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      int value = getResources().getConfiguration().fontWeightAdjustment;
      // FONT_WEIGHT_ADJUSTMENT_UNDEFINED 的取值是 Integer.MAX_VALUE
      if (value != Integer.MAX_VALUE) {
        fontWeightAdjustment = value;
      }
    }
    String script =
        "window.__applySystemInsets&&window.__applySystemInsets("
            + safeTop
            + ", "
            + pageSafeBottom
            + ");"
            + "window.__applyFontWeight&&window.__applyFontWeight("
            + fontWeightAdjustment
            + ")";
    webView.post(() -> webView.evaluateJavascript(script, null));
  }

  /** 系统里没有能打开该文件的应用时通知页面，用页面语言提示 */
  private void notifyFileOpenFailed() {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      return;
    }
    webView.post(
        () ->
            webView.evaluateJavascript(
                "window.__fileOpenFailed&&window.__fileOpenFailed()", null));
  }

  /** 原生文档选择完成，把缓存路径列表交给页面 */
  private void notifyDocumentsPicked(String json) {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      return;
    }
    webView.post(
        () ->
            webView.evaluateJavascript(
                "window.__nativeDocumentsPicked&&window.__nativeDocumentsPicked(" + json + ")",
                null));
  }

  /** 系统里既没有 SAF 也没有内容选择器时通知页面，由页面回退到 <input> */
  private void notifyDocumentsUnavailable() {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      return;
    }
    webView.post(
        () ->
            webView.evaluateJavascript(
                "window.__nativeDocumentsUnavailable&&window.__nativeDocumentsUnavailable()",
                null));
  }

  /** 导出保存结果统一走这里回调页面 */
  /** 相机返回后把缓存照片交给页面；取消、文件为空分别回调 */
  private void finishNativePhoto(int resultCode) {
    String path = pendingPhotoPath;
    pendingPhotoPath = null;
    if (resultCode != RESULT_OK || path == null) {
      notifyPhotoCancelled();
      return;
    }
    File file = new File(path);
    if (!file.exists() || file.length() <= 0) {
      file.delete();
      notifyPhotoFailed();
      return;
    }
    try {
      JSONObject item = new JSONObject();
      item.put("name", file.getName());
      item.put("mime", "image/jpeg");
      item.put("size", file.length());
      item.put("path", file.getAbsolutePath());
      notifyPhotoPicked(item.toString());
    } catch (Exception error) {
      notifyPhotoFailed();
    }
  }

  private void notifyPhotoPicked(String json) {
    notifyPage("window.__nativePhotoPicked&&window.__nativePhotoPicked(" + json + ")");
  }

  private void notifyPhotoCancelled() {
    notifyPage("window.__nativePhotoCancelled&&window.__nativePhotoCancelled()");
  }

  private void notifyPhotoFailed() {
    notifyPage("window.__nativePhotoFailed&&window.__nativePhotoFailed()");
  }

  private void notifyPhotoUnavailable() {
    notifyPage("window.__nativePhotoUnavailable&&window.__nativePhotoUnavailable()");
  }

  private void notifyPage(String script) {
    WebView webView = getBridge() == null ? null : getBridge().getWebView();
    if (webView == null) {
      return;
    }
    webView.post(() -> webView.evaluateJavascript(script, null));
  }

  private void notifyDocumentSaved() {
    notifyPage("window.__nativeDocumentSaved&&window.__nativeDocumentSaved()");
  }

  private void notifyDocumentSaveCancelled() {
    notifyPage("window.__nativeDocumentSaveCancelled&&window.__nativeDocumentSaveCancelled()");
  }

  private void notifyDocumentSaveFailed() {
    notifyPage("window.__nativeDocumentSaveFailed&&window.__nativeDocumentSaveFailed()");
  }

  private void notifyDocumentSaveUnavailable() {
    notifyPage("window.__nativeDocumentSaveUnavailable&&window.__nativeDocumentSaveUnavailable()");
  }

  private void applyIconTheme(boolean dark) {
    WindowInsetsControllerCompat controller =
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    controller.setAppearanceLightStatusBars(!dark);
    controller.setAppearanceLightNavigationBars(!dark);
  }

  /** 页面通过 window.SystemBars 读取安全区、同步系统栏图标明暗。 */
  public class SystemBars {

    @JavascriptInterface
    public String getInsets() {
      return "{\\"top\\":"
          + safeTop
          + ",\\"bottom\\":"
          + pageSafeBottom

          + "}";
    }

    @JavascriptInterface
    public void setDarkIcons(boolean dark) {
      runOnUiThread(() -> applyIconTheme(dark));
    }

    /** 页面里 window.open 打不开外部链接，交给系统浏览器 */
    @JavascriptInterface
    public void openExternal(String url) {
      runOnUiThread(
          () -> {
            try {
              Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
              intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
              startActivity(intent);
            } catch (Exception ignored) {
              // 没有能处理该链接的应用时保持安静
            }
          });
    }

    /** 把缓存里的附件交给系统默认应用打开（Word、WPS、PDF 阅读器等） */
    @JavascriptInterface
    public void openFile(String uri, String mimeType) {
      runOnUiThread(
          () -> {
            try {
              Uri parsed = Uri.parse(uri);
              Uri target = parsed;
              if ("file".equals(parsed.getScheme())) {
                File file = new File(parsed.getPath());
                target =
                    FileProvider.getUriForFile(
                        MainActivity.this, getPackageName() + ".fileprovider", file);
              }
              Intent intent = new Intent(Intent.ACTION_VIEW);
              intent.setDataAndType(target, mimeType);
              intent.addFlags(
                  Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
              startActivity(intent);
            } catch (Exception error) {
              notifyFileOpenFailed();
            }
          });
    }

    /** 打开系统文档选择器（SAF）；没有 DocumentsUI 时退到 ACTION_GET_CONTENT */
    @JavascriptInterface
    public void pickDocuments() {
      runOnUiThread(
          () -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
              startActivityForResult(intent, REQUEST_PICK_DOCUMENTS);
              return;
            } catch (ActivityNotFoundException ignored) {
              // 极少数裁剪 ROM 没有 DocumentsUI
            }
            Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
            fallback.addCategory(Intent.CATEGORY_OPENABLE);
            fallback.setType("*/*");
            fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
              startActivityForResult(fallback, REQUEST_PICK_DOCUMENTS);
              return;
            } catch (ActivityNotFoundException ignored) {
              notifyDocumentsUnavailable();
            }
          });
    }

    /** 页面读完缓存副本后调用，避免大文件在缓存里堆积 */
    @JavascriptInterface
    public void deleteCachedDocument(String path) {
      File dir = new File(getCacheDir(), ATTACHMENT_CACHE_DIR);
      File file = new File(path);
      try {
        String dirPrefix = dir.getCanonicalPath() + File.separator;
        if (file.getCanonicalPath().startsWith(dirPrefix)) {
          file.delete();
        }
      } catch (Exception ignored) {
        // 路径不合法时不处理
      }
    }

    /** 拍照：由原生直接发起系统相机，卓易通等兼容层才会把它映射到相机而不是相册 */
    @JavascriptInterface
    public void takePhoto() {
      runOnUiThread(
          () -> {
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            if (intent.resolveActivity(getPackageManager()) == null) {
              notifyPhotoUnavailable();
              return;
            }
            File dir = new File(getCacheDir(), ATTACHMENT_CACHE_DIR);
            if (!dir.exists() && !dir.mkdirs()) {
              notifyPhotoFailed();
              return;
            }
            File output = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
            try {
              Uri uri =
                  FileProvider.getUriForFile(
                      MainActivity.this, getPackageName() + ".fileprovider", output);
              intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
              intent.addFlags(
                  Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
              pendingPhotoPath = output.getAbsolutePath();
              startActivityForResult(intent, REQUEST_TAKE_PHOTO);
            } catch (Exception error) {
              pendingPhotoPath = null;
              notifyPhotoUnavailable();
            }
          });
    }

    /** 导出完成后让用户在系统「保存到」对话框里选位置（含 Documents），零存储权限 */
    @JavascriptInterface
    public void saveDocument(String sourcePath, String name) {
      runOnUiThread(
          () -> {
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("application/zip");
            intent.putExtra(Intent.EXTRA_TITLE, name);
            pendingExportPath = sourcePath;
            try {
              startActivityForResult(intent, REQUEST_SAVE_DOCUMENT);
            } catch (ActivityNotFoundException ignored) {
              pendingExportPath = null;
              notifyDocumentSaveUnavailable();
            }
          });
    }
  }
}
`

const androidBuildGradle = 'android/app/build.gradle'

if (existsSync(androidBuildGradle)) {
  const gradle = readFileSync(androidBuildGradle, 'utf8')
  const packageName = /namespace\s+["']([^"']+)["']/.exec(gradle)?.[1]
  if (packageName) {
    const activityDir = join('android/app/src/main/java', ...packageName.split('.'))
    mkdirSync(activityDir, { recursive: true })
    writeFileSync(join(activityDir, 'MainActivity.java'), mainActivitySource(packageName))
  }
}

// 版本号统一从 package.json 取：安卓的 versionName/versionCode 由这里写入，
// 桌面端 Tauri 的 version 字段本来就指向 package.json。
const packageJsonPath = 'package.json'

if (existsSync(androidBuildGradle) && existsSync(packageJsonPath)) {
  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (version) {
    const [major, minor, patch] = String(version)
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
    const versionCode = major * 10000 + (minor ?? 0) * 100 + (patch ?? 0)
    const gradle = readFileSync(androidBuildGradle, 'utf8')
    const patched = gradle
      .replace(/versionCode \d+/, `versionCode ${versionCode}`)
      .replace(/versionName "[^"]*"/, `versionName "${version}"`)
    if (patched !== gradle) {
      writeFileSync(androidBuildGradle, patched)
    }
  }
}

// 发布签名：android/ 不入库，签名配置只能在工程生成之后补进去。
// keystore 由 workflow 解码到 android/app/release.keystore，密码走环境变量；
// 三者缺一就不注入，release 包保持未签名，不影响其它构建。
const releaseKeystore = 'android/app/release.keystore'
// PKCS12 不支持「库密码 != 密钥密码」，keyPassword 缺省时复用 store 密码
const signingEnvKeys = ['ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS']

if (
  existsSync(androidBuildGradle) &&
  existsSync(releaseKeystore) &&
  signingEnvKeys.every((key) => process.env[key])
) {
  const gradle = readFileSync(androidBuildGradle, 'utf8')
  if (!gradle.includes('signingConfigs.release')) {
    appendFileSync(
      androidBuildGradle,
      `
// 发布签名（由 scripts/prepare-native.mjs 注入）
android {
  signingConfigs {
    release {
      storeFile file("release.keystore")
      storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
      keyAlias System.getenv("ANDROID_KEY_ALIAS")
      keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
    }
  }
  buildTypes {
    release {
      signingConfig signingConfigs.release
    }
  }
}
`
    )
  }
}
