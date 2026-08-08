package com.erwann.voxal.app;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Switches room audio between the loudspeaker and the earpiece (receiver).
 *
 * The web layer cannot do this on Android at all: {@code setSinkId} is
 * unimplemented on the platform, in Chrome and in the WebView alike, so routing
 * has to come from {@link AudioManager}.
 *
 * Three details matter:
 *
 * <ul>
 *   <li>The earpiece is only selectable in {@link AudioManager#MODE_IN_COMMUNICATION};
 *       in the default mode the request is silently ignored.</li>
 *   <li>The speaker route deliberately restores {@link AudioManager#MODE_NORMAL}
 *       and clears any pinned device, i.e. it returns the device to exactly the
 *       state this app left it in before the feature existed — which already
 *       played through the loudspeaker. Leaving a finished call in communication
 *       mode would hand the volume keys to the call stream.</li>
 *   <li>Neither route force-pins a built-in output when a headset is connected —
 *       a wired, USB or Bluetooth output keeps the audio in both modes, which is
 *       what a user plugging in headphones expects.</li>
 * </ul>
 *
 * API 31+ uses {@code setCommunicationDevice}; {@code setSpeakerphoneOn} is kept
 * as the fallback for API 24–30 (minSdk is 24).
 */
@CapacitorPlugin(name = "AudioRoute")
public class AudioRoutePlugin extends Plugin {

  private static final String ATTRIBUTION_TAG = "push_to_talk_audio";
  private static final String ROUTE_SPEAKER = "speaker";
  private static final String ROUTE_EARPIECE = "earpiece";

  private AudioManager audioManager() {
    Context context = getContext();
    if (context == null) return null;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context = context.createAttributionContext(ATTRIBUTION_TAG);
    }
    return (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
  }

  @PluginMethod
  public void getRoute(PluginCall call) {
    AudioManager am = audioManager();
    if (am == null) {
      call.reject("AudioManager unavailable");
      return;
    }
    call.resolve(new JSObject().put("route", currentRoute(am)));
  }

  @PluginMethod
  public void setRoute(PluginCall call) {
    String route = call.getString("route");
    boolean earpiece = ROUTE_EARPIECE.equals(route);
    if (!earpiece && !ROUTE_SPEAKER.equals(route)) {
      call.reject("route must be \"speaker\" or \"earpiece\"");
      return;
    }
    AudioManager am = audioManager();
    if (am == null) {
      call.reject("AudioManager unavailable");
      return;
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        applyModern(am, earpiece);
      } else {
        applyLegacy(am, earpiece);
      }
    } catch (Exception e) {
      call.reject("Failed to apply the " + route + " audio route: " + e.getMessage());
      return;
    }
    call.resolve(new JSObject().put("route", currentRoute(am)));
  }

  private void applyModern(AudioManager am, boolean earpiece) {
    if (!earpiece) {
      am.clearCommunicationDevice();
      am.setMode(AudioManager.MODE_NORMAL);
      return;
    }
    // Without communication mode the earpiece is not a selectable output.
    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
    List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
    // A headset outranks the earpiece: clearing hands the choice back to the
    // platform, which routes to the attached device.
    if (hasExternalOutput(devices)) {
      am.clearCommunicationDevice();
      return;
    }
    for (AudioDeviceInfo device : devices) {
      if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
        am.setCommunicationDevice(device);
        return;
      }
    }
    // No earpiece on this device at all (tablets, most Android TV boxes).
    am.clearCommunicationDevice();
  }

  private void applyLegacy(AudioManager am, boolean earpiece) {
    if (!earpiece) {
      am.setSpeakerphoneOn(false);
      am.setMode(AudioManager.MODE_NORMAL);
      return;
    }
    am.setMode(AudioManager.MODE_IN_COMMUNICATION);
    am.setSpeakerphoneOn(false);
  }

  private boolean hasExternalOutput(List<AudioDeviceInfo> devices) {
    for (AudioDeviceInfo device : devices) {
      switch (device.getType()) {
        case AudioDeviceInfo.TYPE_WIRED_HEADSET:
        case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
        case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
        case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
        case AudioDeviceInfo.TYPE_USB_HEADSET:
          return true;
        default:
          break;
      }
    }
    return false;
  }

  private String currentRoute(AudioManager am) {
    // Outside communication mode nothing is pinned and playback goes to the
    // loudspeaker, so the mode has to be part of the answer — on the legacy path
    // `isSpeakerphoneOn()` is false in that state and would read as "earpiece".
    if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) return ROUTE_SPEAKER;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      AudioDeviceInfo device = am.getCommunicationDevice();
      boolean onEarpiece = device != null && device.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
      return onEarpiece ? ROUTE_EARPIECE : ROUTE_SPEAKER;
    }
    return am.isSpeakerphoneOn() ? ROUTE_SPEAKER : ROUTE_EARPIECE;
  }
}
