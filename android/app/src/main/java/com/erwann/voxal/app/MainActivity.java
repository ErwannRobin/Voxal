package com.erwann.voxal.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(AudioForegroundPlugin.class);
    super.onCreate(savedInstanceState);
  }

  @Override
  public void onPause() {
    super.onPause();
    if (PushToTalkService.isRunning && getBridge() != null && getBridge().getWebView() != null) {
      getBridge().getWebView().resumeTimers();
    }
  }

  @Override
  public void onStop() {
    super.onStop();
    if (PushToTalkService.isRunning && getBridge() != null && getBridge().getWebView() != null) {
      getBridge().getWebView().resumeTimers();
    }
  }
}
