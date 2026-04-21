package com.push2talk.app;

import android.content.Context;
import android.media.AudioManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioForeground")
public class AudioForegroundPlugin extends Plugin {

  private AudioManager audioManager;

  @Override
  public void load() {
    audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
  }

  @PluginMethod
  public void start(PluginCall call) {
    if (audioManager == null) {
      call.reject("AudioManager not available");
      return;
    }

    int focusResult = audioManager.requestAudioFocus(
      null,
      AudioManager.STREAM_VOICE_CALL,
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
    );

    if (focusResult == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      call.resolve(new JSObject().put("success", true));
    } else {
      call.reject("Failed to request audio focus");
    }
  }

  @PluginMethod
  public void stop(PluginCall call) {
    if (audioManager != null) {
      audioManager.abandonAudioFocus(null);
    }
    call.resolve();
  }
}
