package com.push2talk.app;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AudioForeground")
public class AudioForegroundPlugin extends Plugin {

  public void start(PluginCall call) {
    try {
      Intent intent = new Intent(getActivity(), PushToTalkService.class);
      intent.setAction("START_PTT");
      
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        getActivity().startForegroundService(intent);
      } else {
        getActivity().startService(intent);
      }
      
      call.resolve(new JSObject().put("success", true));
    } catch (Exception e) {
      call.reject("Failed to start foreground service: " + e.getMessage());
    }
  }

  public void stop(PluginCall call) {
    try {
      Intent intent = new Intent(getActivity(), PushToTalkService.class);
      intent.setAction("STOP_PTT");
      getActivity().startService(intent);
      call.resolve();
    } catch (Exception e) {
      call.reject("Failed to stop service: " + e.getMessage());
    }
  }
}
