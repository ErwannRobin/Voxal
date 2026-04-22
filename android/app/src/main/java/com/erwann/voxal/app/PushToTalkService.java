package com.erwann.voxal.app;

import android.app.Service;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

public class PushToTalkService extends Service {
  private static final int NOTIFICATION_ID = 1;
  private static final String CHANNEL_ID = "push2talk_channel";
  private AudioManager audioManager;

  public static boolean isRunning = false;

  @Override
  public void onCreate() {
    super.onCreate();
    createNotificationChannel();
    audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null && "START_PTT".equals(intent.getAction())) {
      isRunning = true;
      startForeground(NOTIFICATION_ID, createNotification().build());
      requestAudioFocus();
    } else if (intent != null && "STOP_PTT".equals(intent.getAction())) {
      isRunning = false;
      releaseAudioFocus();
      stopForeground(STOP_FOREGROUND_REMOVE);
      stopSelf();
    }
    return START_STICKY;
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
        "Push-to-Talk",
        NotificationManager.IMPORTANCE_LOW
      );
      channel.setSound(null, null);
      NotificationManager manager = getSystemService(NotificationManager.class);
      if (manager != null) {
        manager.createNotificationChannel(channel);
      }
    }
  }

  private NotificationCompat.Builder createNotification() {
    return new NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Push-to-Talk")
      .setContentText("Microphone is active")
      .setSmallIcon(android.R.drawable.ic_dialog_info)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW);
  }

  private void requestAudioFocus() {
    if (audioManager != null) {
      audioManager.requestAudioFocus(
        null,
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
      );
    }
  }

  private void releaseAudioFocus() {
    if (audioManager != null) {
      audioManager.abandonAudioFocus(null);
    }
  }
}
