package com.erwann.voxal.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.lang.ref.WeakReference;

/**
 * Bridges Android screen capture into the WebView.
 *
 * Android's WebView does not implement getDisplayMedia (Chromium hides it there
 * deliberately so feature detection works), so JavaScript cannot obtain a screen
 * MediaStream on its own. This plugin drives {@link ScreenCaptureService} and
 * forwards its H.264 output; `src/main.js` decodes it with WebCodecs and draws
 * to a canvas, whose captureStream() is the MediaStream the room publishes.
 *
 * Events:
 *   screenCaptureConfig  { codec, width, height }
 *   screenCaptureChunk   { data (base64 Annex-B), key, timestamp }
 *   screenCaptureStopped { reason, message }
 */
@CapacitorPlugin(name = "ScreenCapture")
public class ScreenCapturePlugin extends Plugin {

  // The service runs in this process but is not owned by the plugin, so it
  // reaches back through a weak reference rather than holding the plugin alive.
  private static WeakReference<ScreenCapturePlugin> instance = new WeakReference<>(null);

  private int maxEdge = 1280;
  private int fps = 24;
  private int bitrate = 800000;

  @Override
  public void load() {
    instance = new WeakReference<>(this);
  }

  /**
   * Whether this binary can capture at all. Called rather than presence-checked
   * on the JS side, because an over-the-air JS update routinely runs on an older
   * native build where this plugin exists but this method does not.
   */
  @PluginMethod
  public void canCapture(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("supported", hasAvcEncoder());
    call.resolve(ret);
  }

  @PluginMethod
  public void start(PluginCall call) {
    if (ScreenCaptureService.isRunning) {
      call.resolve();
      return;
    }
    maxEdge = call.getInt("maxEdge", 1280);
    fps = call.getInt("fps", 24);
    bitrate = call.getInt("bitrate", 800000);

    MediaProjectionManager mpm = (MediaProjectionManager)
      getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    if (mpm == null) {
      call.reject("unsupported");
      return;
    }
    // The consent dialog. Its result Intent is single-use and must be in hand
    // before the foreground service starts (see ScreenCaptureService).
    startActivityForResult(call, mpm.createScreenCaptureIntent(), "onConsent");
  }

  @ActivityCallback
  private void onConsent(PluginCall call, androidx.activity.result.ActivityResult result) {
    if (call == null) return;
    if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
      call.reject("cancelled");
      return;
    }
    Intent intent = new Intent(getActivity(), ScreenCaptureService.class);
    intent.setAction(ScreenCaptureService.ACTION_START);
    intent.putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.getResultCode());
    intent.putExtra(ScreenCaptureService.EXTRA_RESULT_DATA, result.getData());
    intent.putExtra(ScreenCaptureService.EXTRA_MAX_EDGE, maxEdge);
    intent.putExtra(ScreenCaptureService.EXTRA_FPS, fps);
    intent.putExtra(ScreenCaptureService.EXTRA_BITRATE, bitrate);
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        getActivity().startForegroundService(intent);
      } else {
        getActivity().startService(intent);
      }
      call.resolve();
    } catch (Exception e) {
      call.reject("failed: " + e.getMessage());
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    try {
      Intent intent = new Intent(getActivity(), ScreenCaptureService.class);
      intent.setAction(ScreenCaptureService.ACTION_STOP);
      getActivity().startService(intent);
    } catch (Exception ignored) {
      // Already gone: stopping something that is not running is not an error.
    }
    call.resolve();
  }

  private boolean hasAvcEncoder() {
    try {
      MediaCodecList list = new MediaCodecList(MediaCodecList.REGULAR_CODECS);
      MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1280, 720);
      return list.findEncoderForFormat(format) != null;
    } catch (Exception e) {
      return false;
    }
  }

  // --- Called from ScreenCaptureService ---------------------------------------

  // Both the codec-config buffer and onOutputFormatChanged can announce the
  // same geometry. Emitting twice would rebuild the JS decoder for nothing and
  // blank the share until the next keyframe, so only real changes go out.
  private static int lastWidth = 0;
  private static int lastHeight = 0;

  static void emitConfig(int width, int height) {
    ScreenCapturePlugin p = instance.get();
    if (p == null) return;
    if (width == lastWidth && height == lastHeight) return;
    lastWidth = width;
    lastHeight = height;
    JSObject data = new JSObject();
    // Baseline 3.1 covers what the encoder is configured for; the decoder reads
    // the real SPS out of the Annex-B stream regardless.
    data.put("codec", "avc1.42E01E");
    data.put("width", width);
    data.put("height", height);
    p.notifyListeners("screenCaptureConfig", data);
  }

  static void emitChunk(String base64, boolean key, long timestampUs) {
    ScreenCapturePlugin p = instance.get();
    if (p == null) return;
    JSObject data = new JSObject();
    data.put("data", base64);
    data.put("key", key);
    data.put("timestamp", timestampUs);
    p.notifyListeners("screenCaptureChunk", data);
  }

  static void emitStopped(String reason, String message) {
    lastWidth = 0;
    lastHeight = 0;
    ScreenCapturePlugin p = instance.get();
    if (p == null) return;
    JSObject data = new JSObject();
    data.put("reason", reason);
    if (message != null) data.put("message", message);
    p.notifyListeners("screenCaptureStopped", data);
  }
}
