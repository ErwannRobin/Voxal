package com.erwann.voxal.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import java.nio.ByteBuffer;

/**
 * Screen capture for the WebView.
 *
 * MediaProjection paints a VirtualDisplay onto a MediaCodec input Surface; the
 * encoder's H.264 output is handed to {@link ScreenCapturePlugin}, which
 * forwards it to JavaScript. Nothing here touches WebRTC — the JS side decodes
 * with WebCodecs and republishes through the same path a desktop screen share
 * uses.
 *
 * Ordering is not negotiable on Android 14+ (API 34): the user's consent Intent
 * must already be in hand, this service must be in the foreground with type
 * mediaProjection BEFORE getMediaProjection(), and a MediaProjection.Callback
 * must be registered before createVirtualDisplay() or that call throws. The
 * consent Intent is also single-use, and one MediaProjection permits exactly
 * one virtual display, so a re-share always means a fresh prompt.
 */
public class ScreenCaptureService extends Service {
  public static final String ACTION_START = "START_SCREEN_CAPTURE";
  public static final String ACTION_STOP = "STOP_SCREEN_CAPTURE";
  public static final String EXTRA_RESULT_CODE = "resultCode";
  public static final String EXTRA_RESULT_DATA = "resultData";
  public static final String EXTRA_MAX_EDGE = "maxEdge";
  public static final String EXTRA_FPS = "fps";
  public static final String EXTRA_BITRATE = "bitrate";

  private static final int NOTIFICATION_ID = 2;
  private static final String CHANNEL_ID = "screen_share_channel";
  private static final String MIME = MediaFormat.MIMETYPE_VIDEO_AVC;

  public static boolean isRunning = false;

  private MediaProjection projection;
  private MediaProjection.Callback projectionCallback;
  private VirtualDisplay virtualDisplay;
  private MediaCodec encoder;
  private Surface inputSurface;

  @Override
  public void onCreate() {
    super.onCreate();
    createNotificationChannel();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent != null ? intent.getAction() : null;
    if (ACTION_STOP.equals(action)) {
      teardown("user");
      return START_NOT_STICKY;
    }
    if (!ACTION_START.equals(action)) return START_NOT_STICKY;

    // Foreground first, then the projection token — the reverse order is a
    // SecurityException on API 34+.
    try {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        buildNotification(),
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
          ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
          : 0
      );
    } catch (Exception e) {
      fail("foreground service refused: " + e.getMessage());
      return START_NOT_STICKY;
    }

    int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
    Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
    int maxEdge = intent.getIntExtra(EXTRA_MAX_EDGE, 1280);
    int fps = intent.getIntExtra(EXTRA_FPS, 24);
    int bitrate = intent.getIntExtra(EXTRA_BITRATE, 800000);

    try {
      startCapture(resultCode, resultData, maxEdge, fps, bitrate);
      isRunning = true;
    } catch (Exception e) {
      fail("capture failed to start: " + e.getMessage());
    }
    return START_NOT_STICKY;
  }

  private void startCapture(int resultCode, Intent resultData, int maxEdge, int fps, int bitrate)
      throws Exception {
    MediaProjectionManager mpm =
      (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
    projection = mpm.getMediaProjection(resultCode, resultData);
    if (projection == null) throw new IllegalStateException("no projection token");

    // Mandatory before createVirtualDisplay() on API 34+, and the only way to
    // learn that the user tapped the system's own stop control or locked the
    // device (Android 15 QPR1+ auto-stops projection on lock).
    projectionCallback = new MediaProjection.Callback() {
      @Override
      public void onStop() {
        teardown("user");
      }
    };
    projection.registerCallback(projectionCallback, null);

    DisplayMetrics metrics = new DisplayMetrics();
    WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
    wm.getDefaultDisplay().getRealMetrics(metrics);
    int[] size = scaleToMaxEdge(metrics.widthPixels, metrics.heightPixels, maxEdge);
    int width = size[0];
    int height = size[1];

    MediaFormat format = MediaFormat.createVideoFormat(MIME, width, height);
    format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
      MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
    format.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
    format.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
    // A keyframe every two seconds: short enough that a decoder that loses sync
    // recovers quickly, long enough not to spend the whole bitrate on IDRs.
    format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);

    encoder = MediaCodec.createEncoderByType(MIME);
    encoder.setCallback(new MediaCodec.Callback() {
      @Override
      public void onInputBufferAvailable(MediaCodec codec, int index) {
        // Surface input — frames arrive from the VirtualDisplay, never here.
      }

      @Override
      public void onOutputBufferAvailable(MediaCodec codec, int index, MediaCodec.BufferInfo info) {
        try {
          ByteBuffer buf = codec.getOutputBuffer(index);
          if (buf != null && info.size > 0) {
            buf.position(info.offset);
            buf.limit(info.offset + info.size);
            byte[] bytes = new byte[info.size];
            buf.get(bytes);
            if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
              // csd-0/csd-1 (SPS/PPS). MediaCodec already emits Annex-B, and
              // it repeats the parameter sets ahead of each IDR, so the JS
              // decoder needs no separate `description` — it just needs to know
              // the geometry.
              ScreenCapturePlugin.emitConfig(width, height);
            } else {
              boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
              ScreenCapturePlugin.emitChunk(
                Base64.encodeToString(bytes, Base64.NO_WRAP),
                key,
                info.presentationTimeUs
              );
            }
          }
          codec.releaseOutputBuffer(index, false);
        } catch (Exception e) {
          fail("encoder output failed: " + e.getMessage());
        }
      }

      @Override
      public void onError(MediaCodec codec, MediaCodec.CodecException e) {
        fail("encoder error: " + e.getMessage());
      }

      @Override
      public void onOutputFormatChanged(MediaCodec codec, MediaFormat fmt) {
        ScreenCapturePlugin.emitConfig(
          fmt.containsKey(MediaFormat.KEY_WIDTH) ? fmt.getInteger(MediaFormat.KEY_WIDTH) : width,
          fmt.containsKey(MediaFormat.KEY_HEIGHT) ? fmt.getInteger(MediaFormat.KEY_HEIGHT) : height
        );
      }
    });
    encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
    inputSurface = encoder.createInputSurface();
    encoder.start();

    virtualDisplay = projection.createVirtualDisplay(
      "VoxalScreenShare",
      width, height, metrics.densityDpi,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
      inputSurface, null, null
    );
  }

  /** Fit the display into maxEdge on its long side, keeping aspect, both even. */
  static int[] scaleToMaxEdge(int width, int height, int maxEdge) {
    int longEdge = Math.max(width, height);
    if (longEdge > maxEdge && longEdge > 0) {
      double scale = (double) maxEdge / longEdge;
      width = (int) Math.round(width * scale);
      height = (int) Math.round(height * scale);
    }
    // H.264 wants even dimensions; an odd one is rejected by some encoders.
    width = Math.max(2, width - (width % 2));
    height = Math.max(2, height - (height % 2));
    return new int[] { width, height };
  }

  private void fail(String message) {
    ScreenCapturePlugin.emitStopped("error", message);
    teardown(null);
  }

  private void teardown(String reason) {
    if (reason != null) ScreenCapturePlugin.emitStopped(reason, null);
    isRunning = false;
    if (virtualDisplay != null) {
      try { virtualDisplay.release(); } catch (Exception ignored) {}
      virtualDisplay = null;
    }
    if (encoder != null) {
      try { encoder.stop(); } catch (Exception ignored) {}
      try { encoder.release(); } catch (Exception ignored) {}
      encoder = null;
    }
    if (inputSurface != null) {
      try { inputSurface.release(); } catch (Exception ignored) {}
      inputSurface = null;
    }
    if (projection != null) {
      if (projectionCallback != null) {
        try { projection.unregisterCallback(projectionCallback); } catch (Exception ignored) {}
        projectionCallback = null;
      }
      try { projection.stop(); } catch (Exception ignored) {}
      projection = null;
    }
    stopForeground(STOP_FOREGROUND_REMOVE);
    stopSelf();
  }

  @Override
  public void onDestroy() {
    isRunning = false;
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private void createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        "Screen sharing",
        NotificationManager.IMPORTANCE_LOW
      );
      channel.setSound(null, null);
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null) manager.createNotificationChannel(channel);
    }
  }

  private Notification buildNotification() {
    return new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Sharing your screen")
      .setContentText("Voxal is sharing your screen with the room")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build();
  }
}
