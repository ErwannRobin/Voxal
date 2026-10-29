export{h as WebGPUBackend}from'./chunk-NYCCJS3G.js';var _=[{model:"xs",dtype:"f16",resolution:{w:384,h:240},skipFrames:2},{model:"small",dtype:"f16",resolution:{w:384,h:224},skipFrames:1},{model:"medium",dtype:"f16",resolution:{w:512,h:320},skipFrames:1},{model:"large",dtype:"f32",resolution:{w:640,h:400},skipFrames:0},{model:"xl",dtype:"f32",resolution:{w:1280,h:768},skipFrames:0}];var B=false;function z(t){B=t;}function g(t){let e=`[longpipe/${t}]`,n=((...r)=>{B&&console.log(e,...r);});return n.warn=(...r)=>{B&&console.warn(e,...r);},n}var w=g("adaptive"),he=2e3,fe=1e4,de=30,me=20,ge=5e3,_e=.3,ve=15e3,P=class{constructor(e){this.opts=e;this.currentPresetIdx=_.findIndex(n=>n.model===e.initialModel),this.lastSwapAt=performance.now();}opts;timer=null;currentPresetIdx;lastSwapAt=0;overshootStart=0;headroomStart=0;start(){w(`started; backend=${this.opts.backendKind} initial=${this.opts.initialModel} idx=${this.currentPresetIdx}`),this.timer=setInterval(()=>{this.tick().catch(e=>w("tick failed:",e));},he);}stop(){this.timer&&clearInterval(this.timer),this.timer=null;}async tick(){if(typeof document<"u"&&document.hidden)return;let e=performance.now();if(e-this.lastSwapAt<fe)return;let n=await this.opts.getStats();if(n.fps<me?(this.overshootStart===0&&(this.overshootStart=e),e-this.overshootStart>=ge&&this.tryDowngrade(n.fps)):this.overshootStart=0,this.opts.backendKind==="webgpu"&&n.modelMs>0){let r=1e3/de*_e;n.modelMs<r?(this.headroomStart===0&&(this.headroomStart=e),e-this.headroomStart>=ve&&this.tryUpgrade(n.modelMs,r)):this.headroomStart=0;}}tryDowngrade(e){if(this.currentPresetIdx<=0)return;let n=this.currentPresetIdx-1;w(`downgrade ${_[this.currentPresetIdx].model} \u2192 ${_[n].model} (fps=${e})`),this.swap(n);}tryUpgrade(e,n){if(_[this.currentPresetIdx+1]?.model==="xl"||this.currentPresetIdx>=_.length-1)return;let r=this.currentPresetIdx+1;w(`upgrade ${_[this.currentPresetIdx].model} \u2192 ${_[r].model} (modelMs=${e.toFixed(1)} < ${n.toFixed(1)})`),this.swap(r);}async swap(e){let n=_[e];this.lastSwapAt=performance.now(),this.overshootStart=0,this.headroomStart=0;try{let r=await this.opts.fetchWeights(n.model);await this.opts.swapPreset(n,r),this.currentPresetIdx=e,w(`swap to ${n.model} done`);}catch(r){w("swap failed:",r),this.opts.onError?.({message:`adaptive preset swap failed: ${r.message??String(r)}`,source:"adaptive",recoverable:true,cause:r});}}};async function H(t){let e,n=false;if(t instanceof HTMLVideoElement){if(e=t.currentSrc||t.src,!e)throw new Error("background video: HTMLVideoElement has no src")}else if(t instanceof Blob)e=URL.createObjectURL(t),n=true;else if(typeof t=="string")e=t;else throw new Error("background video: unsupported input shape");let r=document.createElement("video");r.crossOrigin="anonymous",r.muted=true,r.loop=true,r.playsInline=true,r.src=e,await new Promise((l,c)=>{r.addEventListener("loadeddata",()=>l(),{once:true}),r.addEventListener("error",()=>c(new Error(`background video: failed to load ${e}`)),{once:true});});try{await r.play();}catch(l){throw new Error(`background video: play() rejected \u2014 ${l.message}`)}let a=new MessageChannel,i=a.port1,s=a.port2,u=false,p=r.requestVideoFrameCallback?.bind(r);if(p){let l=(c,h)=>{if(!u){try{let d=new VideoFrame(r,{timestamp:h.mediaTime*1e6});i.postMessage({frame:d},[d]);}catch{}p(l);}};p(l);}else {let l=()=>{if(!u){try{let c=new VideoFrame(r,{timestamp:performance.now()*1e3});i.postMessage({frame:c},[c]);}catch{}requestAnimationFrame(l);}};requestAnimationFrame(l);}return {port:s,transferList:[s],cleanup:()=>{u=true,i.close(),r.pause(),r.removeAttribute("src"),r.load(),n&&URL.revokeObjectURL(e);}}}var xe=4,M=8,N=16;async function E(t){if(typeof t=="string")return t==="none"?{background:{kind:"none"}}:t==="blur"?{background:{kind:"blur",sigma:M}}:{background:{kind:"image",bitmap:await V(t)}};if(t instanceof ImageBitmap)return {background:{kind:"image",bitmap:t}};if(typeof HTMLImageElement<"u"&&t instanceof HTMLImageElement)return {background:{kind:"image",bitmap:await createImageBitmap(t)}};if(typeof HTMLVideoElement<"u"&&t instanceof HTMLVideoElement)return await G(t);let e=t;if(e.color!==void 0)return {background:{kind:"color",rgb:be(e.color)}};if(e.blur!==void 0)return {background:{kind:"blur",sigma:we(e.blur)}};if(e.image!==void 0)return {background:{kind:"image",bitmap:await ye(e.image)}};if(e.video!==void 0)return await G(e.video);throw new Error(`background: unrecognized input shape \u2014 ${x(t)}`)}async function G(t){let e;if(typeof t=="string")e=t;else if(typeof HTMLVideoElement<"u"&&t instanceof HTMLVideoElement)e=t;else if(t&&typeof t=="object"&&"data"in t&&"type"in t)e=t.data instanceof Blob?t.data:new Blob([t.data],{type:t.type});else throw new Error(`background.video: unrecognized shape \u2014 ${x(t)}`);let n=await H(e);return {background:{kind:"video",port:n.port},transferList:n.transferList,cleanup:n.cleanup}}function be(t){if(typeof t=="string"){let e=t.trim().replace(/^#/,"");if(/^[0-9a-fA-F]{6}$/.test(e))return [parseInt(e.slice(0,2),16)/255,parseInt(e.slice(2,4),16)/255,parseInt(e.slice(4,6),16)/255];if(/^[0-9a-fA-F]{3}$/.test(e))return [parseInt(e[0]+e[0],16)/255,parseInt(e[1]+e[1],16)/255,parseInt(e[2]+e[2],16)/255];throw new Error(`background.color: hex must be #rgb or #rrggbb, got ${x(t)}`)}if(!Array.isArray(t)||t.length!==3||!t.every(e=>typeof e=="number"&&Number.isFinite(e)&&e>=0&&e<=1))throw new Error(`background.color: expected hex string or [r, g, b] floats in [0, 1], got ${x(t)}`);return [t[0],t[1],t[2]]}function we(t){if(t===true)return M;if("sigma"in t){if(typeof t.sigma!="number"||!Number.isFinite(t.sigma)||t.sigma<0)throw new Error(`background.blur.sigma must be a non-negative number, got ${t.sigma}`);return t.sigma}if("strength"in t){let e=t.strength;if(typeof e=="number"){let n=Math.max(0,Math.min(1,e));return N*n}if(e==="low")return xe;if(e==="medium")return M;if(e==="high")return N;throw new Error(`background.blur.strength must be 'low' | 'medium' | 'high' | number, got ${x(e)}`)}throw new Error(`background.blur: must be true, { strength }, or { sigma } \u2014 got ${x(t)}`)}async function ye(t){if(t instanceof ImageBitmap)return t;if(typeof HTMLImageElement<"u"&&t instanceof HTMLImageElement)return createImageBitmap(t);if(typeof t=="string")return V(t);if(t&&typeof t=="object"&&"data"in t&&"type"in t){let e=t.data instanceof Blob?t.data:new Blob([t.data],{type:t.type});return createImageBitmap(e)}throw new Error(`background.image: unrecognized shape \u2014 ${x(t)}`)}async function V(t){let e=await fetch(t);if(!e.ok)throw new Error(`background: failed to load image from ${t} (HTTP ${e.status})`);let n=await e.blob();return createImageBitmap(n)}function x(t){return t===null?"null":typeof t!="object"?typeof t+"("+String(t)+")":`${t.constructor?.name??"Object"} ${JSON.stringify(t).slice(0,80)}`}function $(){return {input:"MediaStreamTrackProcessor"in self?"mstp":"rvfc-postmessage",output:"MediaStreamTrackGenerator"in self?"mstg":ke()?"transfer-capture":"bitmap-shuttle"}}var A=null;function ke(){return A!==null||(A=!/Firefox/.test(navigator.userAgent)),A}function j(t){return t==="denoise"?{mode:"denoise",denoise:{}}:typeof t=="object"?{mode:"denoise",denoise:t.denoise}:{mode:t}}function X(t,e,n,r){let a=[t];return n.mode==="passthrough"?a.push(...e.getAudioTracks()):n.mode==="denoise"&&r&&a.push(r),new MediaStream(a)}var y={rnnoise:{wasm:"rnnoise.wasm",weights:null,scaleIn:32768,scaleOut:30517578125e-15,needsSimd:false,exports:{malloc:"malloc",create:"rn_create",process:"rn_process"}},dfn:{wasm:"dfn.wasm",weights:"dfn_weights.pack",scaleIn:1,scaleOut:1,needsSimd:true,exports:{malloc:"df_lite_malloc",create:"df_lite_create",process:"df_lite_process",setBeta:"df_lite_set_beta",setGruLeak:"df_lite_set_gru_leak"}},dfnint8:{wasm:"dfn.wasm",weights:"dfn_weights_int8.pack",scaleIn:1,scaleOut:1,needsSimd:true,exports:{malloc:"df_lite_malloc",create:"df_lite_create_i8",process:"df_lite_process",setBeta:"df_lite_set_beta",setGruLeak:"df_lite_set_gru_leak"}}},Ce={high:"dfn",mid:"dfnint8",low:"rnnoise"},Te=["high","mid","low"];function Pe(t){return Te.includes(t)}function q(t){return Pe(t)?Ce[t]:t}function K(t,e){return `${t.replace(/\/$/,"")}/${e}`}async function Y(t){let e=await fetch(t);if(!e.ok)throw new Error(`audio asset fetch failed: ${e.status} ${t}`);return e.arrayBuffer()}async function Q(t,e){let n=y[t],[r,a]=await Promise.all([Y(K(e,n.wasm)),n.weights?Y(K(e,n.weights)):Promise.resolve(null)]);return {wasmBytes:r,weights:a}}function S(){try{return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,11]))}catch{return  false}}var Ee=1.3,Ae=64,Se=3,Fe=`
self.onmessage = async (e) => {
  const { wasmUrl, iters, rounds, budget } = e.data
  try {
    const res = await fetch(wasmUrl)
    if (!res.ok) throw new Error(res.status + ' ' + wasmUrl)
    const module = await WebAssembly.compile(await res.arrayBuffer())
    const imports = {}
    for (const im of WebAssembly.Module.imports(module)) {
      ;(imports[im.module] = imports[im.module] || {})
      if (im.kind === 'function') imports[im.module][im.name] = () => 0
    }
    const ex = new WebAssembly.Instance(module, imports).exports
    const best = (fn) => {
      fn(iters)                                   // warm up
      let b = Infinity
      for (let r = 0; r < rounds; r++) {
        const t = performance.now()
        fn(iters)
        b = Math.min(b, (performance.now() - t) / iters)
      }
      return b
    }
    const dfnMs = best(ex.calibrate_f32)
    const int8Ms = ex.calibrate_i8 ? best(ex.calibrate_i8) : Infinity
    const model = dfnMs <= budget ? 'dfn' : int8Ms <= budget ? 'dfnint8' : 'rnnoise'
    self.postMessage({ model, dfnMs, int8Ms })
  } catch (err) {
    self.postMessage({ error: (err && err.message) || String(err) })
  }
}
`;async function J(t,e){if(!S())return "rnnoise";let n=`${t.replace(/\/$/,"")}/${y.dfn.wasm}`,r=null,a=null;try{r=URL.createObjectURL(new Blob([Fe],{type:"application/javascript"})),a=new Worker(r);let i=await new Promise((s,u)=>{a.onmessage=p=>s(p.data),a.onerror=p=>u(new Error(p.message||"probe worker error")),a.postMessage({wasmUrl:n,iters:Ae,rounds:Se,budget:Ee});});if(i.error)throw new Error(i.error);return i.model??"rnnoise"}catch(i){return e?.(`audio tier probe failed (${i.message??String(i)}); using rnnoise`),"rnnoise"}finally{a?.terminate(),r&&URL.revokeObjectURL(r);}}var O='var b=Object.defineProperty;var y=(u,a,i)=>a in u?b(u,a,{enumerable:!0,configurable:!0,writable:!0,value:i}):u[a]=i;var r=(u,a,i)=>y(u,typeof a!="symbol"?a+"":a,i);var f={rnnoise:{wasm:"rnnoise.wasm",weights:null,scaleIn:32768,scaleOut:30517578125e-15,needsSimd:!1,exports:{malloc:"malloc",create:"rn_create",process:"rn_process"}},dfn:{wasm:"dfn.wasm",weights:"dfn_weights.pack",scaleIn:1,scaleOut:1,needsSimd:!0,exports:{malloc:"df_lite_malloc",create:"df_lite_create",process:"df_lite_process",setBeta:"df_lite_set_beta",setGruLeak:"df_lite_set_gru_leak"}},dfnint8:{wasm:"dfn.wasm",weights:"dfn_weights_int8.pack",scaleIn:1,scaleOut:1,needsSimd:!0,exports:{malloc:"df_lite_malloc",create:"df_lite_create_i8",process:"df_lite_process",setBeta:"df_lite_set_beta",setGruLeak:"df_lite_set_gru_leak"}}};var c=4096,m=class extends AudioWorkletProcessor{constructor(i){super();r(this,"cfg");r(this,"mem");r(this,"run");r(this,"state",0);r(this,"inPtr",0);r(this,"outPtr",0);r(this,"setBeta",null);r(this,"setGruLeak",null);r(this,"resample",!1);r(this,"rsPush",null);r(this,"inRs",0);r(this,"outRs",0);r(this,"rsDevInPtr",0);r(this,"rsOutPtr",0);r(this,"enabled");r(this,"model");r(this,"inAcc",new Float32Array(480));r(this,"inFill",0);r(this,"outRing",new Float32Array(4096));r(this,"outRead",0);r(this,"outWrite",0);r(this,"outCount",0);r(this,"primed",!1);r(this,"now");r(this,"times",new Float32Array(256));r(this,"tIdx",0);r(this,"hops",0);r(this,"_f32",null);let o=i.processorOptions;this.model=o.model,this.enabled=o.enabled,this.cfg=f[o.model];try{let t=this.instantiate(o.wasmBytes),e=n=>n?t[n]:void 0;this.mem=t.memory;let s=t[this.cfg.exports.malloc];if(this.run=t[this.cfg.exports.process],this.inPtr=s(480*4),this.outPtr=s(480*4),o.weights?this.state=t[this.cfg.exports.create](this.upload(s,o.weights),o.weights.byteLength):this.state=t[this.cfg.exports.create](),this.setBeta=e(this.cfg.exports.setBeta)??null,this.setGruLeak=e(this.cfg.exports.setGruLeak)??null,this.setBeta&&(o.postFilterBeta??0)>0&&this.setBeta(this.state,o.postFilterBeta),this.setGruLeak&&(o.gruLeak??1)<1&&this.setGruLeak(this.state,o.gruLeak),sampleRate!==48e3){let n=t.df_resampler_create;this.rsPush=t.df_resampler_push??null,n&&this.rsPush?(this.resample=!0,this.inRs=n(sampleRate,48e3),this.outRs=n(48e3,sampleRate),this.rsDevInPtr=s(256*4),this.rsOutPtr=s(c*4)):this.post({type:"error",message:`${o.model} can\'t resample ${sampleRate}\\u219248000 Hz; needs a 48 kHz AudioContext`})}}catch(t){let e=t;this.post({type:"error",message:`denoise init failed: ${e.message??String(t)}${e.stack?`\n`+e.stack:""}`})}this.now=typeof performance<"u"&&performance.now?()=>performance.now():null,this.port.onmessage=t=>{let e=t.data;e.type==="enabled"?this.enabled=e.value:e.type==="config"&&(this.setBeta&&e.postFilterBeta!=null&&this.setBeta(this.state,e.postFilterBeta),this.setGruLeak&&e.gruLeak!=null&&this.setGruLeak(this.state,e.gruLeak))},this.post({type:"ready"})}instantiate(i){var e;let o=new WebAssembly.Module(i),t={};for(let s of WebAssembly.Module.imports(o))t[e=s.module]??(t[e]={}),s.kind==="function"?t[s.module][s.name]=()=>0:s.kind==="memory"?t[s.module][s.name]=new WebAssembly.Memory({initial:256}):s.kind==="table"?t[s.module][s.name]=new WebAssembly.Table({initial:0,element:"anyfunc"}):s.kind==="global"&&(t[s.module][s.name]=new WebAssembly.Global({value:"i32",mutable:!1},0));return new WebAssembly.Instance(o,t).exports}upload(i,o){let t=new Uint8Array(o),e=i(t.length);return new Uint8Array(this.mem.buffer).set(t,e),e}heap(){return(!this._f32||this._f32.buffer!==this.mem.buffer)&&(this._f32=new Float32Array(this.mem.buffer)),this._f32}post(i){this.port.postMessage(i)}pushOut(i){this.outRing[this.outWrite]=i,this.outWrite=(this.outWrite+1)%this.outRing.length,this.outCount++}feed48k(i,o){for(let t=0;t<o;t++)this.inAcc[this.inFill++]=i[t],this.inFill===480&&(this.runHop(),this.inFill=0)}runHop(){let i=this.heap(),o=this.inPtr>>2;for(let e=0;e<480;e++)i[o+e]=this.inAcc[e]*this.cfg.scaleIn;let t=this.now?this.now():0;if(this.run(this.state,this.inPtr,this.outPtr),this.now&&(this.times[this.tIdx=this.tIdx+1&255]=this.now()-t),this.resample&&this.rsPush){let e=this.rsPush(this.outRs,this.outPtr,480,this.rsOutPtr,c);i=this.heap();let s=this.rsOutPtr>>2;for(let n=0;n<e;n++)this.pushOut(i[s+n])}else{let e=this.outPtr>>2;for(let s=0;s<480;s++)this.pushOut(i[e+s]*this.cfg.scaleOut)}++this.hops>=50&&(this.reportStats(),this.hops=0)}reportStats(){let i=Array.from(this.times).filter(e=>e>0).sort((e,s)=>e-s),o=e=>i.length?i[Math.min(i.length-1,Math.floor(e*i.length))]:null,t={model:this.model,p50Ms:this.now?o(.5):null,p95Ms:this.now?o(.95):null,latencyMs:this.outCount/sampleRate*1e3,active:this.enabled&&this.state!==0,sampleRate};this.post({type:"stats",stats:t})}process(i,o){let t=i[0]?.[0],e=o[0]?.[0];if(!e)return!0;let s=e.length;if(!t||!this.enabled||this.state===0)return t&&!this.enabled?e.set(t):e.fill(0),!0;if(this.resample&&this.rsPush){let n=this.heap(),g=this.rsDevInPtr>>2;for(let h=0;h<s;h++)n[g+h]=t[h];let d=this.rsPush(this.inRs,this.rsDevInPtr,s,this.rsOutPtr,c);n=this.heap(),this.feed48k(n.subarray(this.rsOutPtr>>2,(this.rsOutPtr>>2)+d),d)}else this.feed48k(t,s);if(!this.primed)if(this.outCount>=480)this.primed=!0;else return e.fill(0),!0;if(this.outCount>=s)for(let n=0;n<s;n++)e[n]=this.outRing[this.outRead],this.outRead=(this.outRead+1)%this.outRing.length,this.outCount--;else e.fill(0);return!0}};registerProcessor("denoise",m);\n';var De=.03,Ue=.995,F=class{constructor(e,n){this.opts=n;this.ctx=new AudioContext({sampleRate:48e3}),this.source=this.ctx.createMediaStreamSource(new MediaStream([e])),this.dest=this.ctx.createMediaStreamDestination(),this.outputTrack=this.dest.stream.getAudioTracks()[0],this.source.connect(this.dest),this.ready=this.init().catch(r=>{this.opts.onError?.(`audio denoise init failed: ${r.message??String(r)}`);});}opts;outputTrack;ready;ctx;source;dest;node=null;model=null;latestStats=null;destroyed=false;resolveExplicit(){let e=q(this.opts.model);return y[e].needsSimd&&!S()?(this.opts.onError?.(`${e} needs wasm SIMD; falling back to rnnoise`),"rnnoise"):e}async init(){let e=this.opts.model==="auto"?await J(this.opts.weightsBaseUrl,this.opts.onError):this.resolveExplicit();this.model=e;let n=await Q(e,this.opts.weightsBaseUrl);if(await this.ctx.audioWorklet.addModule(Re()),this.destroyed)return;let r={model:e,wasmBytes:n.wasmBytes,weights:n.weights,enabled:this.opts.enabled??true,postFilterBeta:this.opts.postFilterBeta??De,gruLeak:this.opts.gruLeak??Ue},a=new AudioWorkletNode(this.ctx,"denoise",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1],processorOptions:r});a.port.onmessage=i=>{let s=i.data;s.type==="stats"?this.latestStats=s.stats:s.type==="error"?this.opts.onError?.(s.message):s.type==="ready"&&this.opts.onReady?.();},this.node=a,this.source.disconnect(this.dest),this.source.connect(a).connect(this.dest);}setEnabled(e){this.node?.port.postMessage({type:"enabled",value:e});}setConfig(e){this.node?.port.postMessage({type:"config",...e});}getStats(){return this.latestStats}destroy(){this.destroyed=true;try{this.node?.disconnect();}catch{}try{this.source.disconnect();}catch{}this.ctx.close();}};function Re(){return URL.createObjectURL(new Blob([O],{type:"application/javascript"}))}var I=g("worker_controller"),D=class{worker;listeners=new Map;persistentEvents=new Set;constructor(e){this.worker=e,this.worker.addEventListener("message",this.handleMessage.bind(this)),I("constructed; message listener attached");}handleMessage(e){let{request_id:n,res:r}=e.data,a=this.listeners.get(n);I("msg received: request_id=",n,"handler?",!!a,"persistent?",this.persistentEvents.has(n)),a&&(a(r),this.persistentEvents.has(n)||this.listeners.delete(n));}addPersistentListener(e,n){this.persistentEvents.add(e),this.listeners.set(e,n),I("addPersistentListener:",e);}removePersistentListener(e){this.persistentEvents.delete(e),this.listeners.delete(e);}sendMessage(e,n,r=[]){let a=crypto.randomUUID();return I("sendMessage:",e,"request_id=",a,"transferables=",r.length),new Promise(i=>{this.listeners.set(a,u=>i(u));let s={cmd:e,data:n,request_id:a};this.worker.postMessage(s,r);})}terminate(){this.worker.terminate(),this.listeners.clear(),this.persistentEvents.clear();}};var Z=g("input-postmessage/main");function ee(t){let e=document.createElement("video");e.srcObject=t,e.muted=true,e.autoplay=true,e.playsInline=true,e.play().catch(o=>{Z.warn("video.play() rejected:",o);});let n=e.requestVideoFrameCallback?.bind(e);if(!n)throw new Error("setupPostMessageInput: requestVideoFrameCallback not supported on this browser");let r=new MessageChannel,a=r.port1,i=r.port2,s=false,u=(o,l)=>{if(!s){try{let c=new VideoFrame(e,{timestamp:l.mediaTime*1e6});a.postMessage({frame:c},[c]);}catch(c){Z.warn("VideoFrame() failed; skipping frame:",c);}n(u);}};return n(u),{port:i,transferList:[i],cleanup:()=>{s=true,a.close(),e.srcObject=null,e.pause();}}}function te(t){let e=t.getVideoTracks();if(e.length===0)throw new Error("setupMstpInput: input MediaStream has no video tracks");let n=e[0],r=self.MediaStreamTrackProcessor;if(!r)throw new Error("setupMstpInput: MediaStreamTrackProcessor not supported on this browser");let i=new r({track:n}).readable;return {readable:i,transferList:[i],cleanup:()=>{i.cancel().catch(()=>{});}}}function ne(t,e){switch(t){case "mstp":{let n=te(e);return {initFields:{inputReadable:n.readable},transferList:n.transferList,cleanup:n.cleanup}}case "rvfc-postmessage":{let n=ee(e);return {initFields:{inputPort:n.port},transferList:n.transferList,cleanup:n.cleanup}}}}var Be=g("bitmap-shuttle/main"),Me=30;function re(t,e=Me){let n=document.createElement("canvas");n.width=t.w,n.height=t.h;let r=n.getContext("bitmaprenderer");if(!r)throw new Error("setupBitmapShuttleOutput: bitmaprenderer context not available");let i=n.captureStream(e).getVideoTracks();if(i.length===0)throw new Error("setupBitmapShuttleOutput: captureStream produced no video tracks");let s=i[0],u=new MessageChannel,p=u.port1,o=u.port2,l=false,c=null,h=()=>{},d=3,f=0;return p.onmessage=k=>{if(l){if(f++,f<d){k.data.bmp.close();return}h();}try{r.transferFromImageBitmap(k.data.bmp);}catch(m){Be.warn("transferFromImageBitmap failed:",m);}},p.start(),{videoTrack:s,port:o,transferList:[o],startPassthrough:k=>{if(l)return;l=true;let m=document.createElement("video");m.srcObject=k,m.muted=true,m.playsInline=true,m.play().catch(()=>{}),c=m;let C="requestVideoFrameCallback"in m?b=>{m.requestVideoFrameCallback(b);}:b=>{requestAnimationFrame(b);},T=()=>{if(l){if(m.videoWidth===0){C(T);return}createImageBitmap(m,{resizeWidth:n.width,resizeHeight:n.height,resizeQuality:"medium"}).then(b=>{if(!l){b.close();return}try{r.transferFromImageBitmap(b);}catch{}C(T);}).catch(()=>{C(T);});}};C(T),h=()=>{l=false,c&&(c.srcObject=null,c.pause(),c=null);};},cleanup:()=>{h(),p.onmessage=null,p.close(),s.stop();}}}function ae(){let t=self.MediaStreamTrackGenerator;if(!t)throw new Error("setupMstgOutput: MediaStreamTrackGenerator not supported on this browser");let e=new t({kind:"video"}),n=e.writable;return {videoTrack:e,writable:n,transferList:[n],cleanup:()=>{n.abort().catch(()=>{}),e.stop();}}}function ie(t,e=30){let n=document.createElement("canvas");n.width=t.w,n.height=t.h;let a=n.captureStream(e).getVideoTracks();if(a.length===0)throw new Error("setupTransferCaptureOutput: captureStream produced no video tracks");let i=a[0],s=n.transferControlToOffscreen();return {videoTrack:i,canvas:s,transferList:[s],cleanup:()=>{i.stop();}}}function se(t,e){switch(t){case "mstg":{let n=ae();return {videoTrack:n.videoTrack,initFields:{outputWritable:n.writable},transferList:n.transferList,cleanup:n.cleanup}}case "transfer-capture":{let n=ie(e);return {videoTrack:n.videoTrack,initFields:{outputCanvas:n.canvas},transferList:n.transferList,cleanup:n.cleanup}}case "bitmap-shuttle":{let n=re(e);return {videoTrack:n.videoTrack,initFields:{outputPort:n.port},transferList:n.transferList,startPassthrough:n.startPassthrough,cleanup:n.cleanup}}}}var W=`var Ya=Object.defineProperty;var Qa=(u,e,r)=>e in u?Ya(u,e,{enumerable:!0,configurable:!0,writable:!0,value:r}):u[e]=r;var i=(u,e,r)=>Qa(u,typeof e!="symbol"?e+"":e,r);var sr=!1;function gr(u){sr=u}function Y(u){let e=\`[longpipe/\${u}]\`,r=((...t)=>{sr&&console.log(e,...t)});return r.warn=(...t)=>{sr&&console.warn(e,...t)},r}var nr=[{model:"xs",dtype:"f16",resolution:{w:384,h:240},skipFrames:2},{model:"small",dtype:"f16",resolution:{w:384,h:224},skipFrames:1},{model:"medium",dtype:"f16",resolution:{w:512,h:320},skipFrames:1},{model:"large",dtype:"f32",resolution:{w:640,h:400},skipFrames:0},{model:"xl",dtype:"f32",resolution:{w:1280,h:768},skipFrames:0}],Ja={fast:0,balanced:2,quality:4};function ge(u){return u==="auto"?null:nr[Ja[u]]}var _e=class{constructor(e,r,t,a){i(this,"op");this.op=e.ops.BilinearUpsample(r,{outH:t,outW:a})}get output(){return this.op.output}run(){this.op.run()}};var be=class{constructor(e,r,t,a){i(this,"op");this.op=e.ops.BicubicUpsample(r,{outH:t,outW:a})}get output(){return this.op.output}run(){this.op.run()}};var ve=class{constructor(e,r,t,a,o="main"){i(this,"presenter");this.presenter=e.presenters.CompositeSolid(r,t,a,o)}run(){this.presenter.run()}};var xe=class{constructor(e,r,t,a,o="main"){i(this,"presenter");this.presenter=e.presenters.CompositeImage(r,t,a,o)}run(){this.presenter.run()}};var ye=class{constructor(e,r,t){i(this,"downs",[]);i(this,"ups",[]);let a=Za(t),o=r;for(let n=0;n<a;n++){let s=e.ops.BilinearUpsample(o,{outH:Math.max(1,Math.floor(o.h/2)),outW:Math.max(1,Math.floor(o.w/2))});this.downs.push(s),o=s.output}for(let n=a-1;n>=1;n--){let s=this.downs[n-1].output,p=e.ops.BilinearUpsample(o,{outH:s.h,outW:s.w});this.ups.push(p),o=p.output}}get output(){return this.ups.length>0?this.ups[this.ups.length-1].output:this.downs[0].output}run(){for(let e of this.downs)e.run();for(let e of this.ups)e.run()}};function Za(u){let e=Math.max(1,3*u);return Math.max(2,Math.min(6,Math.round(Math.log2(e))))}var ei=.05,we=class{constructor(e,r,t,a,o="main"){i(this,"blur");i(this,"presenter");a<=ei?(this.blur=null,this.presenter=e.presenters.CompositeImage(r,t,r,o)):(this.blur=new ye(e,r,a),this.presenter=e.presenters.CompositeImageBilinear(r,t,this.blur.output,o))}run(){this.blur?.run(),this.presenter.run()}};var ke=class{constructor(e){i(this,"backend",e);i(this,"displayInput");i(this,"image");i(this,"network",null);i(this,"networkInput",null);i(this,"upscaler",null);i(this,"upscalerMode","bilinear");i(this,"bgConfig",{mode:"solid",color:[0,0,0]});i(this,"effectChain",[]);i(this,"viewRect",null);i(this,"viewFg",null);i(this,"viewAlpha",null);i(this,"displayDirty",!1);i(this,"compositors",new Map);let r=e.canvas;this.displayInput=e.ops.Input(r.height,r.width),this.image=this.displayInput.output}attachNetwork(e,r,t){this.network=e,this.networkInput=r,this.upscalerMode=t.upscaler,this.bgConfig=t.background,this.upscaler=this.makeUpscaler(),this.rebuildView(),this.compositors.clear()}hasNetwork(){return this.network!==null}setSource(e){this.networkInput?.setSource(e),this.displayInput.setSource(e),this.displayDirty=!0}setUpscaler(e){e!==this.upscalerMode&&(this.upscalerMode=e,this.network&&(this.upscaler=this.makeUpscaler(),this.rebuildView(),this.compositors.clear()))}setBackground(e){this.bgConfig=e}get displayImage(){return this.image}fgImage(){return this.viewFg?this.viewFg.output:this.chainTail()}chainTail(){return this.effectChain.length?this.effectChain[this.effectChain.length-1].output:this.image}alphaImage(){if(!this.upscaler)throw new Error("RenderOp.alphaImage called before attachNetwork");return this.viewAlpha?this.viewAlpha.output:this.upscaler.output}setViewTransform(e){this.viewRect=e,this.rebuildView(),this.compositors.clear()}rebuildView(){this.viewFg=null,this.viewAlpha=null,this.viewRect&&(this.viewFg=this.backend.ops.Reframe(this.chainTail(),this.viewRect),this.upscaler&&(this.viewAlpha=this.backend.ops.Reframe(this.upscaler.output,this.viewRect)))}setEffectChain(e){this.effectChain=e,this.rebuildView(),this.compositors.clear()}runEffects(){for(let e of this.effectChain)e.run();this.viewFg?.run(),this.viewAlpha?.run()}run(){this.runModel(),this.runDisplay()}runDisplay(){this.refreshDisplayInput(),this.runEffects(),this.compositeMain("effect")}runFgPassthrough(){this.refreshDisplayInput(),this.runEffects(),this.compositeMain("fg")}runPassthrough(){this.refreshDisplayInput(),this.compositeMain("raw")}compositeMain(e){let r=e==="effect"?this.bgConfig:e==="fg"?{mode:"fg-passthrough"}:{mode:"passthrough"};this.compositeTo("main",r)}refreshDisplayInput(){this.displayDirty&&(this.displayInput.run(),this.displayDirty=!1)}compositeTo(e,r){let t=this.compositors.get(e);if(t&&ti(t.spec,r)){t.handle.run();return}let a=this.buildCompositor(e,r);this.compositors.set(e,{spec:r,handle:a}),a.run()}applyAlpha(e){if(!this.network||!this.upscaler)throw new Error("RenderOp.applyAlpha called before attachNetwork");this.backend.copyTensor(e,this.network.output),this.upscaler.run()}runModel(){if(!this.network||!this.networkInput||!this.upscaler)throw new Error("RenderOp.runModel called before attachNetwork");this.networkInput.run(),this.network.run(),this.upscaler.run()}makeUpscaler(){if(!this.network)throw new Error("makeUpscaler called with no network");let{backend:e,network:r,image:t}=this;return this.upscalerMode==="bicubic"?new be(e,r.output,t.h,t.w):new _e(e,r.output,t.h,t.w)}buildCompositor(e,r){let{backend:t,image:a}=this;if(r.mode==="passthrough")return t.presenters.CompositePassthrough(a,e);let o=this.fgImage();if(r.mode==="fg-passthrough")return t.presenters.CompositePassthrough(o,e);if(!this.upscaler)throw new Error("RenderOp.compositeTo (effect spec) called before attachNetwork");let n=this.alphaImage();switch(r.mode){case"solid":return new ve(t,o,n,r.color,e);case"image":return new xe(t,o,n,r.image,e);case"blur":return new we(t,o,n,r.sigma,e)}}};function ti(u,e){if(u.mode!==e.mode)return!1;switch(e.mode){case"passthrough":return!0;case"fg-passthrough":return!0;case"solid":{let r=u.color;return r[0]===e.color[0]&&r[1]===e.color[1]&&r[2]===e.color[2]}case"blur":return u.sigma===e.sigma;case"image":return u.image===e.image}}var ri=u=>typeof u=="object"&&u!==null&&typeof u.offset=="number"&&typeof u.length=="number";function ur(u){if(u.byteLength<4)throw new Error("weights buffer too small");let e=new DataView(u,0,4).getUint32(0,!0),r=4+e;if(u.byteLength<r)throw new Error("weights buffer truncated (header)");let t=new Uint8Array(u,4,e),a=JSON.parse(new TextDecoder().decode(t)),o=a.__dtype__??"f32",n=o==="f16"?2:4;if(r%n!==0)throw new Error(\`payload not \${n}-byte aligned (header=\${e})\`);let s=(u.byteLength-r)/n,p=c=>{if(ri(c)){let{offset:l,length:f}=c;if(l+f>s)throw new Error(\`array ref out of range: offset=\${l} length=\${f}\`);let d=r+l*n;return o==="f16"?new Uint16Array(u,d,f):new Float32Array(u,d,f)}if(Array.isArray(c))return c.map(p);if(typeof c=="object"&&c!==null){let l={};for(let f of Object.keys(c))f!=="__dtype__"&&(l[f]=p(c[f]));return l}return c};return p(a)}function _r(u,e,r,t){let a=t.variant,o=a==="E"||a==="D",n=a==="D",s=e.h,p=e.w,c=[],l=null,f=null,d=0,_=0,b;if(o)if(n){if(!r.down2)throw new Error("variant D requires w.down2");d=Math.round(s/1.25),_=Math.round(p/1.25);let x=u.ops.Conv2d(e,r.down1,{outChannels:t.cHigh,kernel:3,stride:1,padding:1,activation:"relu"});c.push(x),f=x.output;let v=u.ops.BilinearUpsample(f,{outH:d,outW:_});c.push(v),l=v.output;let y=u.ops.DownAdapter(l,r.down2,r.adapter,{stride:2});c.push(y),b=y.output}else{if(!r.down2)throw new Error("variant E requires w.down2");let x=u.ops.Conv2d(e,r.down1,{outChannels:t.cHigh,kernel:3,stride:2,padding:1,activation:"relu"});c.push(x),l=x.output,d=l.h,_=l.w;let v=u.ops.DownAdapter(l,r.down2,r.adapter,{stride:2});c.push(v),b=v.output}else{let x=a==="A"?2:3,v=u.ops.DownAdapter(e,r.down1,r.adapter,{stride:x});c.push(v),b=v.output}return{steps:c,adapted:b,d1:l,dFull:f,midH:d,midW:_}}function br(u,e,r,t,a,o,n,s,p){let c=p.variant,l=c==="E"||c==="D",f=c==="D",d=[],_=u.ops.ConvExpand(r,s.expandFeat);d.push(_);let b=_.output,x;if(l){if(!s.up1Combine)throw new Error("two-stage variant requires w.up1Combine");let y=u.ops.BilinearUpsample(b,{outH:o,outW:n});d.push(y);let W=u.ops.CatConv6to2(y.output,t,s.up1Combine);d.push(W);let B=u.ops.BilinearUpsample(W.output,{outH:e.h,outW:e.w});d.push(B),x=B.output}else{let y=u.ops.BilinearUpsample(b,{outH:e.h,outW:e.w});d.push(y),x=y.output}let v=f?u.ops.UpFinalSkip(x,a,e,s.upCombine):u.ops.UpFinal(x,e,s.upCombine);return d.push(v),{steps:d,alpha:v.output}}var Te=class{constructor(e,r,t,a,o,n){i(this,"inputs");i(this,"output");i(this,"encoderTaps");i(this,"halfTap");i(this,"steps");this.inputs=[r];let s=_r(e,r,a,o),p=new n(e,s.adapted,t),c=e.ops.BilinearUpsample(p.featLowRes,{outH:s.adapted.h,outW:s.adapted.w}),l=br(e,r,c.output,s.d1,s.dFull,s.midH,s.midW,a,o);this.steps=[...s.steps,p,c,...l.steps],this.output=l.alpha,this.encoderTaps=p.encoderTaps,this.halfTap=p.halfTap}run(){for(let e of this.steps)e.run()}};var oi=[5,5,3,3],ai=[2,2,1,1];function Pe(u,e,r,t){if(e.h===r.h&&e.w===r.w)return e;let a=u.ops.Crop(e,{outH:r.h,outW:r.w});return t.push(a),a.output}var Ce=class{constructor(e,r,t,a,o,n=16,s={}){i(this,"inputs");i(this,"output");i(this,"steps");this.inputs=[r,t,...a,...s.halfTap?[s.halfTap]:[]];let p=[],c=e.ops.ChannelConcat(r,t);p.push(c);let l=e.ops.Conv2d(c.output,o.stem,{outChannels:n,kernel:7,stride:2,padding:3,activation:"relu6"});p.push(l);let f=[],d=l.output;if(s.fuseStem&&s.halfTap){let v=Pe(e,s.halfTap,l.output,p),y=e.ops.ChannelConcat(l.output,v);p.push(y),f.push(y.output),d=y.output}for(let v=0;v<a.length;v++){let y=e.ops.Conv2d(d,o.stages[v],{outChannels:n,kernel:oi[v],stride:2,padding:ai[v],activation:"relu6"});p.push(y);let W=Pe(e,a[v],y.output,p),B=e.ops.ChannelConcat(y.output,W);p.push(B),f.push(B.output),d=B.output}let _=e.ops.Conv2d(f[f.length-1],o.predictBot,{outChannels:4,kernel:3,stride:1,padding:1,activation:"none"});p.push(_);let b=_.output,x=f[f.length-1];for(let v=0;v<f.length-1;v++){let y=f.length-2-v,W=e.ops.BilinearUpsample(x,{outH:x.h*2,outW:x.w*2}),B=e.ops.Conv2d(W.output,o.deconv[v],{outChannels:n,kernel:3,stride:1,padding:1,activation:"relu6"}),M=e.ops.BilinearUpsample(b,{outH:b.h*2,outW:b.w*2});p.push(W,B,M);let T=Pe(e,B.output,f[y],p),F=Pe(e,M.output,f[y],p),D=e.ops.ChannelConcat(f[y],T),E=e.ops.ChannelConcat(D.output,F);p.push(D,E);let R=e.ops.Conv2d(E.output,o.predict[v],{outChannels:4,kernel:3,stride:1,padding:1,activation:"none"});p.push(R),b=R.output,x=E.output}this.output=b,this.steps=p}run(){for(let e of this.steps)e.run()}};var I=class{constructor(e,r,t,a,o){i(this,"inputs");i(this,"output");i(this,"upOp");i(this,"concatConvOp");i(this,"conv2Op");this.inputs=[r,t],this.upOp=e.ops.BilinearUpsample(r,{outH:t.h,outW:t.w}),this.concatConvOp=e.ops.ConcatConv2d(this.upOp.output,t,a.conv1,{outChannels:o.outChannels}),this.conv2Op=e.ops.Conv2d(this.concatConvOp.output,a.conv2,{outChannels:o.outChannels,kernel:3,stride:1,padding:1,activation:"relu6"}),this.output=this.conv2Op.output}run(){this.upOp.run(),this.concatConvOp.run(),this.conv2Op.run()}};var ii=64,si=48,ni=32,ui=8,We=class{constructor(e,r,t){i(this,"inputs");i(this,"output");i(this,"steps");if(r.length<3)throw new Error(\`FaceHeatmapNet: needs \\u22653 encoder taps, got \${r.length}\`);let a=r[r.length-1],o=r[r.length-2],n=r[r.length-3];this.inputs=[a,o,n];let s=[],p=e.ops.Conv2d(a,t.proj,{outChannels:ii,kernel:1,stride:1,padding:0,activation:"relu6"});s.push(p);let c=new I(e,p.output,o,t.block1,{outChannels:si}),l=new I(e,c.output,n,t.block2,{outChannels:ni});s.push(c,l);let f=e.ops.Conv2d(l.output,t.out,{outChannels:ui,kernel:1,stride:1,padding:0,activation:"none"}),d=e.ops.Sigmoid(f.output);s.push(f,d),this.output=d.output,this.steps=s}run(){for(let e of this.steps)e.run()}};var le=[{c:12,stride:2},{c:12,stride:1},{c:24,stride:2},{c:24,stride:1},{c:48,stride:2},{c:48,stride:1},{c:48,stride:1},{c:64,stride:2},{c:64,stride:1},{c:96,stride:2}],pi=32,ci=478,li=ci*2,Ge=class{constructor(e,r,t){i(this,"inputs");i(this,"output");i(this,"steps");if(t.blocks.length!==le.length)throw new Error(\`LandmarkNet: expected \${le.length} block weights, got \${t.blocks.length}\`);this.inputs=[r];let a=[],o=e.ops.Conv2d(r,t.stem,{outChannels:8,kernel:3,stride:2,padding:1,activation:"relu6"});a.push(o);let n=o.output;for(let c=0;c<le.length;c++){let l=e.ops.Conv2d(n,t.blocks[c],{outChannels:le[c].c,kernel:3,stride:le[c].stride,padding:1,activation:"relu6"});a.push(l),n=l.output}let s=e.ops.Conv2d(n,t.headConv,{outChannels:pi,kernel:1,stride:1,padding:0,activation:"relu6"});a.push(s);let p=e.ops.Conv2d(s.output,t.fc,{outChannels:li,kernel:s.output.h,stride:1,padding:0,activation:"none"});a.push(p),this.output=p.output,this.steps=a}run(){for(let e of this.steps)e.run()}};var Q=class{constructor(e,r,t,a){i(this,"inputs");i(this,"output");i(this,"dwOp");i(this,"pwOp");this.inputs=[r],this.dwOp=e.ops.DepthwiseConv2d(r,t.dw,{kernel:a.kernel,stride:a.stride,padding:a.padding,activation:"relu6"}),this.pwOp=e.ops.Conv2d(this.dwOp.output,t.pw,{outChannels:a.outChannels,kernel:1,stride:1,padding:0,activation:"none"}),this.output=this.pwOp.output}run(){this.dwOp.run(),this.pwOp.run()}};var k=class{constructor(e,r,t,a){i(this,"inputs");i(this,"output");i(this,"expandOp");i(this,"dwOp");i(this,"projOp");this.inputs=[r];let o=a.midChannels!==a.inChannels,n=a.stride===1&&a.inChannels===a.outChannels;this.expandOp=o?e.ops.Conv2d(r,t.expand,{outChannels:a.midChannels,kernel:1,stride:1,padding:0,activation:"relu6"}):null;let s=this.expandOp?this.expandOp.output:r;this.dwOp=e.ops.DepthwiseConv2d(s,t.dw,{kernel:a.kernel,stride:a.stride,padding:a.padding,activation:"relu6"}),this.projOp=n?e.ops.ProjResidual(this.dwOp.output,r,t.proj,{outChannels:a.outChannels}):e.ops.Conv2d(this.dwOp.output,t.proj,{outChannels:a.outChannels,kernel:1,stride:1,padding:0,activation:"none"}),this.output=this.projOp.output}run(){this.expandOp?.run(),this.dwOp.run(),this.projOp.run()}};var Ue=class{constructor(e,r,t){i(this,"output");i(this,"featLowRes");i(this,"encoderTaps");i(this,"halfTap");i(this,"stem");i(this,"s0");i(this,"s1b0");i(this,"s1b1");i(this,"s2b0");i(this,"s2b1");i(this,"s3b0");i(this,"s3b1");i(this,"s3b2");i(this,"s4b0");i(this,"s4b1");i(this,"s4b2");i(this,"bottleneck");i(this,"dec0");i(this,"dec1");i(this,"finalUp");i(this,"outConv");i(this,"alpha");this.stem=e.ops.Conv2d(r,t.encoder.stem,{outChannels:32,kernel:3,stride:2,padding:"same",activation:"relu6"}),this.s0=new Q(e,this.stem.output,t.encoder.s0,{outChannels:16,kernel:3,stride:1,padding:1}),this.s1b0=new k(e,this.s0.output,t.encoder.s1[0],{inChannels:16,midChannels:96,outChannels:24,kernel:3,stride:2,padding:"same"}),this.s1b1=new k(e,this.s1b0.output,t.encoder.s1[1],{inChannels:24,midChannels:144,outChannels:24,kernel:3,stride:1,padding:1}),this.s2b0=new k(e,this.s1b1.output,t.encoder.s2[0],{inChannels:24,midChannels:144,outChannels:40,kernel:5,stride:2,padding:"same"}),this.s2b1=new k(e,this.s2b0.output,t.encoder.s2[1],{inChannels:40,midChannels:240,outChannels:40,kernel:5,stride:1,padding:2}),this.s3b0=new k(e,this.s2b1.output,t.encoder.s3[0],{inChannels:40,midChannels:240,outChannels:80,kernel:3,stride:2,padding:"same"}),this.s3b1=new k(e,this.s3b0.output,t.encoder.s3[1],{inChannels:80,midChannels:480,outChannels:80,kernel:3,stride:1,padding:1}),this.s3b2=new k(e,this.s3b1.output,t.encoder.s3[2],{inChannels:80,midChannels:480,outChannels:80,kernel:3,stride:1,padding:1}),this.s4b0=new k(e,this.s3b2.output,t.encoder.s4[0],{inChannels:80,midChannels:480,outChannels:112,kernel:5,stride:1,padding:2}),this.s4b1=new k(e,this.s4b0.output,t.encoder.s4[1],{inChannels:112,midChannels:672,outChannels:112,kernel:5,stride:1,padding:2}),this.s4b2=new k(e,this.s4b1.output,t.encoder.s4[2],{inChannels:112,midChannels:672,outChannels:112,kernel:5,stride:1,padding:2}),this.bottleneck=e.ops.Conv2d(this.s4b2.output,t.bottleneck,{outChannels:128,kernel:1,stride:1,padding:0,activation:"relu6"}),this.dec0=new I(e,this.bottleneck.output,this.s2b1.output,t.decoder.blocks[0],{outChannels:64}),this.dec1=new I(e,this.dec0.output,this.s1b1.output,t.decoder.blocks[1],{outChannels:32}),this.finalUp=e.ops.UpsampleConv1x1(this.dec1.output,t.decoder.finalUpsample,{outH:this.dec1.output.h*2,outW:this.dec1.output.w*2,outChannels:32,activation:"relu6"}),this.featLowRes=this.finalUp.output,this.encoderTaps=[this.s1b1.output,this.s2b1.output,this.s4b2.output],this.halfTap=this.s0.output,this.outConv=e.ops.Conv2d(this.finalUp.output,t.decoder.outputConv,{outChannels:4,kernel:1,stride:1,padding:0,activation:"none"}),this.alpha=e.ops.UpsampleSigmoid(this.outConv.output,{outH:this.outConv.output.h*2,outW:this.outConv.output.w*2}),this.output=this.alpha.output}run(){this.stem.run(),this.s0.run(),this.s1b0.run(),this.s1b1.run(),this.s2b0.run(),this.s2b1.run(),this.s3b0.run(),this.s3b1.run(),this.s3b2.run(),this.s4b0.run(),this.s4b1.run(),this.s4b2.run(),this.bottleneck.run(),this.dec0.run(),this.dec1.run(),this.finalUp.run(),this.outConv.run(),this.alpha.run()}};var Be=class{constructor(e,r,t){i(this,"output");i(this,"featLowRes");i(this,"encoderTaps");i(this,"stem");i(this,"s0");i(this,"s1b0");i(this,"s1b1");i(this,"s2b0");i(this,"s2b1");i(this,"s3b0");i(this,"s3b1");i(this,"s3b2");i(this,"s4b0");i(this,"s4b1");i(this,"s4b2");i(this,"s5b0");i(this,"s5b1");i(this,"s5b2");i(this,"s5b3");i(this,"s6b0");i(this,"bottleneck");i(this,"dec0");i(this,"dec1");i(this,"dec2");i(this,"finalUp");i(this,"outConv");i(this,"alpha");this.stem=e.ops.Conv2d(r,t.encoder.stem,{outChannels:32,kernel:3,stride:2,padding:"same",activation:"relu6"}),this.s0=new Q(e,this.stem.output,t.encoder.s0,{outChannels:16,kernel:3,stride:1,padding:1}),this.s1b0=new k(e,this.s0.output,t.encoder.s1[0],{inChannels:16,midChannels:96,outChannels:24,kernel:3,stride:2,padding:"same"}),this.s1b1=new k(e,this.s1b0.output,t.encoder.s1[1],{inChannels:24,midChannels:144,outChannels:24,kernel:3,stride:1,padding:1}),this.s2b0=new k(e,this.s1b1.output,t.encoder.s2[0],{inChannels:24,midChannels:144,outChannels:40,kernel:5,stride:2,padding:"same"}),this.s2b1=new k(e,this.s2b0.output,t.encoder.s2[1],{inChannels:40,midChannels:240,outChannels:40,kernel:5,stride:1,padding:2}),this.s3b0=new k(e,this.s2b1.output,t.encoder.s3[0],{inChannels:40,midChannels:240,outChannels:80,kernel:3,stride:2,padding:"same"}),this.s3b1=new k(e,this.s3b0.output,t.encoder.s3[1],{inChannels:80,midChannels:480,outChannels:80,kernel:3,stride:1,padding:1}),this.s3b2=new k(e,this.s3b1.output,t.encoder.s3[2],{inChannels:80,midChannels:480,outChannels:80,kernel:3,stride:1,padding:1}),this.s4b0=new k(e,this.s3b2.output,t.encoder.s4[0],{inChannels:80,midChannels:480,outChannels:112,kernel:5,stride:1,padding:2}),this.s4b1=new k(e,this.s4b0.output,t.encoder.s4[1],{inChannels:112,midChannels:672,outChannels:112,kernel:5,stride:1,padding:2}),this.s4b2=new k(e,this.s4b1.output,t.encoder.s4[2],{inChannels:112,midChannels:672,outChannels:112,kernel:5,stride:1,padding:2}),this.s5b0=new k(e,this.s4b2.output,t.encoder.s5[0],{inChannels:112,midChannels:672,outChannels:192,kernel:5,stride:2,padding:"same"}),this.s5b1=new k(e,this.s5b0.output,t.encoder.s5[1],{inChannels:192,midChannels:1152,outChannels:192,kernel:5,stride:1,padding:2}),this.s5b2=new k(e,this.s5b1.output,t.encoder.s5[2],{inChannels:192,midChannels:1152,outChannels:192,kernel:5,stride:1,padding:2}),this.s5b3=new k(e,this.s5b2.output,t.encoder.s5[3],{inChannels:192,midChannels:1152,outChannels:192,kernel:5,stride:1,padding:2}),this.s6b0=new k(e,this.s5b3.output,t.encoder.s6[0],{inChannels:192,midChannels:1152,outChannels:320,kernel:3,stride:1,padding:1}),this.bottleneck=e.ops.Conv2d(this.s6b0.output,t.bottleneck,{outChannels:128,kernel:1,stride:1,padding:0,activation:"relu6"}),this.dec0=new I(e,this.bottleneck.output,this.s4b2.output,t.decoder.blocks[0],{outChannels:64}),this.dec1=new I(e,this.dec0.output,this.s2b1.output,t.decoder.blocks[1],{outChannels:32}),this.dec2=new I(e,this.dec1.output,this.s1b1.output,t.decoder.blocks[2],{outChannels:16}),this.finalUp=e.ops.UpsampleConv1x1(this.dec2.output,t.decoder.finalUpsample,{outH:this.dec2.output.h*2,outW:this.dec2.output.w*2,outChannels:16,activation:"relu6"}),this.featLowRes=this.finalUp.output,this.encoderTaps=[this.s1b1.output,this.s2b1.output,this.s4b2.output,this.s6b0.output],this.outConv=e.ops.Conv2d(this.finalUp.output,t.decoder.outputConv,{outChannels:4,kernel:1,stride:1,padding:0,activation:"none"}),this.alpha=e.ops.UpsampleSigmoid(this.outConv.output,{outH:this.outConv.output.h*2,outW:this.outConv.output.w*2}),this.output=this.alpha.output}run(){this.stem.run(),this.s0.run(),this.s1b0.run(),this.s1b1.run(),this.s2b0.run(),this.s2b1.run(),this.s3b0.run(),this.s3b1.run(),this.s3b2.run(),this.s4b0.run(),this.s4b1.run(),this.s4b2.run(),this.s5b0.run(),this.s5b1.run(),this.s5b2.run(),this.s5b3.run(),this.s6b0.run(),this.bottleneck.run(),this.dec0.run(),this.dec1.run(),this.dec2.run(),this.finalUp.run(),this.outConv.run(),this.alpha.run()}};var pr=[[{in:24,mid:144,out:32,k:3,s:2},{in:32,mid:192,out:32,k:3,s:1},{in:32,mid:192,out:32,k:3,s:1}],[{in:32,mid:192,out:48,k:5,s:2},{in:48,mid:288,out:48,k:5,s:1},{in:48,mid:288,out:48,k:5,s:1}],[{in:48,mid:288,out:96,k:3,s:2},{in:96,mid:576,out:96,k:3,s:1},{in:96,mid:576,out:96,k:3,s:1},{in:96,mid:576,out:96,k:3,s:1},{in:96,mid:576,out:96,k:3,s:1}],[{in:96,mid:576,out:136,k:5,s:1},{in:136,mid:816,out:136,k:5,s:1},{in:136,mid:816,out:136,k:5,s:1},{in:136,mid:816,out:136,k:5,s:1},{in:136,mid:816,out:136,k:5,s:1}],[{in:136,mid:816,out:232,k:5,s:2},{in:232,mid:1392,out:232,k:5,s:1},{in:232,mid:1392,out:232,k:5,s:1},{in:232,mid:1392,out:232,k:5,s:1},{in:232,mid:1392,out:232,k:5,s:1},{in:232,mid:1392,out:232,k:5,s:1}],[{in:232,mid:1392,out:384,k:3,s:1}]],Se=class{constructor(e,r,t){i(this,"output");i(this,"featLowRes");i(this,"encoderTaps");i(this,"stem");i(this,"s0");i(this,"stages");i(this,"bottleneck");i(this,"dec0");i(this,"dec1");i(this,"dec2");i(this,"finalUp");i(this,"outConv");i(this,"alpha");this.stem=e.ops.Conv2d(r,t.encoder.stem,{outChannels:32,kernel:3,stride:2,padding:"same",activation:"relu6"}),this.s0=new Q(e,this.stem.output,t.encoder.s0,{outChannels:24,kernel:3,stride:1,padding:1});let a=[t.encoder.s1,t.encoder.s2,t.encoder.s3,t.encoder.s4,t.encoder.s5,t.encoder.s6];this.stages=[];let o=this.s0.output;for(let f=0;f<pr.length;f++){let d=[];for(let _=0;_<pr[f].length;_++){let b=pr[f][_],x=new k(e,o,a[f][_],{inChannels:b.in,midChannels:b.mid,outChannels:b.out,kernel:b.k,stride:b.s,padding:b.s===2?"same":(b.k-1)/2});d.push(x),o=x.output}this.stages.push(d)}let n=f=>this.stages[f][this.stages[f].length-1].output,s=n(0),p=n(1),c=n(3),l=n(5);this.bottleneck=e.ops.Conv2d(l,t.bottleneck,{outChannels:256,kernel:1,stride:1,padding:0,activation:"relu6"}),this.dec0=new I(e,this.bottleneck.output,c,t.decoder.blocks[0],{outChannels:128}),this.dec1=new I(e,this.dec0.output,p,t.decoder.blocks[1],{outChannels:64}),this.dec2=new I(e,this.dec1.output,s,t.decoder.blocks[2],{outChannels:32}),this.finalUp=e.ops.UpsampleConv1x1(this.dec2.output,t.decoder.finalUpsample,{outH:this.dec2.output.h*2,outW:this.dec2.output.w*2,outChannels:32,activation:"relu6"}),this.featLowRes=this.finalUp.output,this.encoderTaps=[s,p,c,l],this.outConv=e.ops.Conv2d(this.finalUp.output,t.decoder.outputConv,{outChannels:4,kernel:1,stride:1,padding:0,activation:"none"}),this.alpha=e.ops.UpsampleSigmoid(this.outConv.output,{outH:this.outConv.output.h*2,outW:this.outConv.output.w*2}),this.output=this.alpha.output}run(){this.stem.run(),this.s0.run();for(let e of this.stages)for(let r of e)r.run();this.bottleneck.run(),this.dec0.run(),this.dec1.run(),this.dec2.run(),this.finalUp.run(),this.outConv.run(),this.alpha.run()}};var vr=Ue,xr=Be,fi=Se,J={xs:{base:vr,wrapper:{variant:"B",cHigh:4,cLow:4,cUp:2},canvasRes:{w:384,h:240},baseRes:{w:128,h:80},flowFuseStem:!0},small:{base:vr,wrapper:{variant:"A",cHigh:4,cLow:4,cUp:2},canvasRes:{w:384,h:224},baseRes:{w:192,h:112}},medium:{base:xr,wrapper:{variant:"A",cHigh:4,cLow:4,cUp:2},canvasRes:{w:512,h:320},baseRes:{w:256,h:160}},large:{base:xr,wrapper:{variant:"D",cHigh:4,cLow:4,cUp:2},canvasRes:{w:640,h:400},baseRes:{w:256,h:160}},xl:{base:fi,wrapper:{variant:"E",cHigh:4,cLow:4,cUp:2},canvasRes:{w:1280,h:768},baseRes:{w:320,h:192}}};var cr={zoom:1.35,gravity:.5,margin:.04},di={deadband:.09,ease:.07},yr=0,wr=1,mi=2,hi=16,gi={tLo:.15,tHi:2.5,leak:.15,release:.9,tDiv:1,divScale:2},kr=256,_i=[.485,.456,.406],bi=[.229,.224,.225],vi={win:3,thresh:.15,boxScale:2.4},xi=new Set(["medium","large","xl"]),yi=4,wi=.6,ki={webgpu:6,webgl:30},Ti=15,Pi=5,Tr=1e3,Ae=class{constructor(e){i(this,"canvas");i(this,"backend");i(this,"backendKind");i(this,"topology");i(this,"preset",null);i(this,"enabled");i(this,"currentBackground");i(this,"modelTimingCounter",0);i(this,"renderOp");i(this,"flow",null);i(this,"faceChain",null);i(this,"faceCfg",null);i(this,"reframe",null);i(this,"reframeCfg",null);i(this,"reframeSolveOnce",!1);i(this,"faceLive",0);i(this,"faceProbePending",!1);i(this,"faceProbeCounter",0);i(this,"tier",null);i(this,"tierInput",null);i(this,"lastTierWeights",null);i(this,"bgImageInputs",new Map);i(this,"bgVideoInputs",new Map);i(this,"bgVideoPorts",new Map);i(this,"previewCanvas",null);i(this,"previewCtx",null);i(this,"previewBg",null);i(this,"previewEffectSpec",null);i(this,"previewIntervalMs",1e3/Ti);i(this,"lastPreviewAt",0);i(this,"skipCounter",0);i(this,"framesRenderedAt",[]);i(this,"modelRunSamples",[]);i(this,"displayRunSamples",[]);i(this,"skippedCount",0);this.backend=e.backend,this.backendKind=e.backendKind,this.canvas=e.canvas,this.enabled=e.enabled,this.currentBackground=e.background,this.topology=e.topology,this.renderOp=new ke(this.backend)}process(e){this.renderOp.setSource(e);let r=performance.now(),t=this.renderOp.hasNetwork(),a=this.enabled&&t&&this.faceChain!==null,o=this.enabled&&t&&this.currentBackground.kind!=="none",n=o||a,s=this.isPreviewTick(r),p=s&&t&&this.previewBg!==null&&this.previewBg.kind!=="none",c=!1;n&&this.flow?c=this.stepFlow():n&&(this.shouldRunModel()?(this.runModelOnce(),c=!0):this.skippedCount++),!c&&p&&(this.runModelOnce(),c=!0),a&&this.stepFace(c);let l=performance.now();s&&this.previewCanvas?(this.backendKind==="webgl"?this.compositePreviewWebGL(o,p,a):(this.compositeMain(o,a),this.renderOp.compositeTo("preview",this.previewSpec(p))),this.lastPreviewAt=r):this.compositeMain(o,a),this.displayRunSamples.push({ts:performance.now(),ms:performance.now()-l}),this.trimSamples(this.displayRunSamples),this.framesRenderedAt.push(performance.now()),this.trim(this.framesRenderedAt)}compositeMain(e,r){e?this.renderOp.runDisplay():r?this.renderOp.runFgPassthrough():this.renderOp.runPassthrough()}compositePreviewWebGL(e,r,t){this.renderOp.refreshDisplayInput(),this.renderOp.runEffects(),this.renderOp.compositeTo("preview",this.previewSpec(r));let a=this.canvas.transferToImageBitmap();this.previewCtx.transferFromImageBitmap(a),this.renderOp.compositeMain(e?"effect":t?"fg":"raw")}previewSpec(e){return e&&this.previewEffectSpec?this.previewEffectSpec:{mode:"passthrough"}}runModelOnce(){let e=performance.now();this.renderOp.runModel(),this.backendKind==="webgpu"&&this.modelTimingCounter%Pi===0&&this.backend.sync().then(()=>{this.modelRunSamples.push({ts:performance.now(),ms:performance.now()-e}),this.trimSamples(this.modelRunSamples)}).catch(()=>{}),this.modelTimingCounter++}stepFlow(){let e=this.flow,r=!1;return e.networkInput.run(),e.curBaseDown.run(),e.everyFrame?(e.net.run(),e.up.run(),this.runModelOnce(),r=!0,this.backend.copyTensor(e.curBaseDown.output,e.frameAHeld),this.backend.copyTensor(e.tier.output,e.predBuf)):this.shouldRunModel()?(this.runModelOnce(),r=!0,this.backend.copyTensor(e.curBaseDown.output,e.frameAHeld),this.backend.copyTensor(e.tier.output,e.alphaHeld),this.backend.copyTensor(e.tier.output,e.predBuf)):(this.skippedCount++,e.net.run(),e.up.run(),e.predWarp.run(),this.backend.copyTensor(e.predWarp.output,e.predBuf)),e.warm?(e.refWarp.run(),e.stab.run(),this.backend.copyTensor(e.stab.output,e.stabPrev),this.renderOp.applyAlpha(e.stab.output),r):(this.backend.copyTensor(e.tier.output,e.stabPrev),e.warm=r,r)}stepFace(e){let r=this.faceChain;if(e?(r.face.run(),this.backend.copyTensor(r.face.output,r.hmBuf),r.hmHeld&&this.backend.copyTensor(r.face.output,r.hmHeld)):r.hmWarp&&this.flow&&(r.hmFlowDown.run(),r.hmWarp.run(),this.backend.copyTensor(r.hmWarp.output,r.hmBuf)),r.boxOp.run(),this.backend.copyTensor(r.boxOp.output,r.boxStable),r.stage){this.probeFaceOccupancy(r);let t=r.crops.length===1?1:this.faceLive;for(let a=0;a<t;a++)r.crops[a].run(),r.lms[a].run();if(t>0)for(let a of r.packLm)a.run();r.stage.setActiveSlots(t)}if(this.reframe){let t=this.reframe,a=t.auto?t.cmdAuto:this.reframeSolveOnce?t.cmdSolve:t.cmdHold;this.backend.copyTensor(a,t.cmd),this.reframeSolveOnce=!1,t.stateOp.run(),this.backend.copyTensor(t.stateOp.output,t.state)}}buildReframe(){this.reframe=null,this.renderOp.setViewTransform(null);let e=this.faceChain,r=this.reframeCfg;if(!r||!e||!this.preset)return;let t=J[this.preset.model].canvasRes,a=r.auto??!0,o=a!==!1,n={...di,...typeof a=="object"?a:{}},s=f=>this.backend.tensor(1,1,4,new Float32Array(f)),p=this.backend.tensor(1,1,8,new Float32Array(8)),c=s([o?yr:wr,0,0,0]),l=this.backend.ops.ReframeState(e.boxStable,p,c,{zoom:r.zoom??cr.zoom,gravity:r.gravity??cr.gravity,margin:r.margin??cr.margin,deadband:n.deadband,ease:n.ease,aspect:t.w/t.h});this.reframe={stateOp:l,state:p,cmd:c,auto:o,cmdAuto:s([yr,0,0,0]),cmdHold:s([wr,0,0,0]),cmdSolve:s([mi,0,0,0])},this.renderOp.setViewTransform(p)}probeFaceOccupancy(e){let r=e.crops.length;if(r===1)return;let t=ki[this.backendKind];this.faceProbePending||this.faceProbeCounter++%t!==0||(this.faceProbePending=!0,this.backend.readback(e.boxStable).then(a=>{let o=0;for(;o<r&&a[o*4+3]>0;)o++;this.faceLive=o,this.faceProbePending=!1}).catch(()=>{this.faceProbePending=!1}))}isPreviewTick(e){return!this.previewCanvas||this.previewBg===null||!this.enabled?!1:e-this.lastPreviewAt>=this.previewIntervalMs}shouldRunModel(){return this.skipCounter===0?(this.skipCounter=this.preset?.skipFrames??0,!0):(this.skipCounter--,!1)}setBackground(e){this.currentBackground=e,this.renderOp.setBackground(this.translateBackgroundFor("main",e))}setEnabled(e){this.enabled=e}attachPreview(e){if(e.width=this.canvas.width,e.height=this.canvas.height,this.previewCanvas=e,this.backendKind==="webgpu")this.backend.attachCanvas("preview",e);else{let r=e.getContext("bitmaprenderer");if(!r)throw new Error("renderer: failed to get bitmaprenderer context for preview canvas");this.previewCtx=r}}setPreview(e,r){this.previewBg=e,this.previewEffectSpec=e.kind==="none"?null:this.translateBackgroundFor("preview",e),r?.fps&&r.fps>0&&(this.previewIntervalMs=1e3/r.fps),this.lastPreviewAt=0}clearPreview(){this.previewBg=null,this.previewEffectSpec=null;let e=this.bgVideoPorts.get("preview");e&&(e.close(),this.bgVideoPorts.delete("preview"))}setPreset(e,r){let t=J[e.model];if(!t)throw new Error(\`renderer: no TIER_CONFIG entry for model '\${e.model}'\`);let a=ur(r),o=this.backend.ops.Input(t.canvasRes.h,t.canvasRes.w),n=new Te(this.backend,o.output,a.base,a.wrapper,t.wrapper,t.base);if(this.renderOp.attachNetwork(n,o,{upscaler:"bilinear",background:this.translateBackgroundFor("main",this.currentBackground)}),this.flow=null,a.flow){let s=t.baseRes,p=t.canvasRes,c=e.skipFrames===0,l=(E,R)=>this.backend.tensor(E,R,4,new Float32Array(E*R*4)),f=this.backend.ops.BilinearUpsample(o.output,{outH:s.h,outW:s.w}),d=l(s.h,s.w),_=new Ce(this.backend,d,f.output,n.encoderTaps,a.flow,hi,t.flowFuseStem?{fuseStem:!0,halfTap:n.halfTap}:{}),b=this.backend.ops.BilinearUpsample(_.output,{outH:p.h,outW:p.w}),x=p.w/s.w,v=l(p.h,p.w),y=l(p.h,p.w),W=this.backend.ops.Warp(y,b.output,{flowScale:x}),B=Math.max(1,Math.round(p.w/_.output.w)),M=Math.max(1,Math.round(p.h/_.output.h)),T=this.backend.ops.Stabilize(b.output,v,W.output,y,{...gi,stepX:B,stepY:M}),F=c?null:l(p.h,p.w),D=F?this.backend.ops.Warp(F,b.output,{flowScale:x}):null;this.flow={tier:n,everyFrame:c,warm:!1,networkInput:o,curBaseDown:f,frameAHeld:d,net:_,up:b,predBuf:v,stabPrev:y,refWarp:W,stab:T,alphaHeld:F,predWarp:D}}this.preset=e,this.skipCounter=0,this.tier=n,this.tierInput=o,this.lastTierWeights=a,this.buildFaceChain()}setFaceEffects(e){this.faceCfg=e,this.preset&&this.buildFaceChain()}setReframe(e){this.reframeCfg=e,this.preset&&this.buildFaceChain()}reframeNow(){this.reframeSolveOnce=!0}buildFaceChain(){this.faceChain=null,this.reframe=null,this.renderOp.setEffectChain([]),this.renderOp.setViewTransform(null);let e=this.faceCfg,r=this.lastTierWeights;if(!e&&!this.reframeCfg||!this.tier||!this.tierInput||!this.preset)return;if(!r?.face){console.warn(\`[longpipe/renderer] face effects configured but the '\${this.preset.model}' weights have no face blob \\u2014 disabled. Re-export the tier with a face-trained checkpoint.\`);return}let t=new We(this.backend,this.tier.encoderTaps,r.face),a=t.output,o=(T,F,D)=>this.backend.tensor(T,F,D,new Float32Array(T*F*D)),n=o(a.h,a.w,a.c),s=null,p=null,c=null;if(this.flow&&(this.preset.skipFrames??0)>0){let T=J[this.preset.model].baseRes.w;s=o(a.h,a.w,a.c),p=this.backend.ops.BilinearUpsample(this.flow.net.output,{outH:a.h,outW:a.w}),c=this.backend.ops.Warp(s,p.output,{flowScale:a.w/T})}let l=xi.has(this.preset.model)?yi:1,f={...vi,...e?.box??{}},d=l>1?this.backend.ops.FaceBoxesFromHeatmaps(n,{...f,maxFaces:l,tol:wi}):this.backend.ops.FaceBoxFromHeatmaps(n,f),_=o(1,l,4);if(!e){this.faceChain={face:t,hmBuf:n,hmHeld:s,hmFlowDown:p,hmWarp:c,boxOp:d,boxStable:_,crops:[],lms:[],packLm:[],stage:null},this.buildReframe();return}let b=ur(e.landmarkWeights),x=this.tierInput.output,v=Array.from({length:l},(T,F)=>this.backend.ops.CropResample(x,_,{outH:kr,outW:kr,mean:_i,std:bi,slot:F})),y=v.map(T=>new Ge(this.backend,T.output,b)),W=[],B=y[0].output;if(l>1){let T=y.map(F=>F.output);for(;T.length>1;){let F=[];for(let D=0;D<T.length;D+=2){let E=this.backend.ops.ChannelConcat(T[D],T[D+1]);W.push(E),F.push(E.output)}T=F}B=T[0]}let M=this.backend.ops.FaceTouchupStage(this.renderOp.displayImage,B,_,e.topology,{...e.touchup,slots:l});this.renderOp.setEffectChain([M]),this.faceLive=l,this.faceProbeCounter=0,this.faceChain={face:t,hmBuf:n,hmHeld:s,hmFlowDown:p,hmWarp:c,boxOp:d,boxStable:_,crops:v,lms:y,packLm:W,stage:M},this.buildReframe()}destroy(){for(let e of this.bgVideoPorts.values())e.close();this.bgVideoPorts.clear(),this.backend.destroy()}getStats(){let e=performance.now();return this.trimRecent(this.framesRenderedAt,e),this.trimSamplesAt(this.modelRunSamples,e),this.trimSamplesAt(this.displayRunSamples,e),{fps:this.framesRenderedAt.length,modelFps:this.modelRunSamples.length,modelMs:Pr(this.modelRunSamples.map(r=>r.ms)),displayMs:Pr(this.displayRunSamples.map(r=>r.ms)),skipped:this.skippedCount,preset:this.preset?.model??"boot",skipFrames:this.preset?.skipFrames??0,enabled:this.enabled,inputPath:this.topology.input,outputPath:this.topology.output}}translateBackgroundFor(e,r){let t=this.bgVideoPorts.get(e);switch(r.kind!=="video"&&t&&(t.close(),this.bgVideoPorts.delete(e)),r.kind){case"none":return{mode:"solid",color:[0,0,0]};case"color":return{mode:"solid",color:r.rgb};case"blur":return{mode:"blur",sigma:r.sigma};case"image":{let a=this.bgInputFor(this.bgImageInputs,e);return a.setSource(r.bitmap),a.run(),{mode:"image",image:a.output}}case"video":{let a=this.bgInputFor(this.bgVideoInputs,e);return t&&t.close(),this.bgVideoPorts.set(e,r.port),r.port.onmessage=o=>{let n=o.data.frame;try{a.setSource(n),a.run()}finally{n.close()}},r.port.start?.(),{mode:"image",image:a.output}}}}bgInputFor(e,r){let t=e.get(r);return t||(t=this.backend.ops.Input(this.canvas.height,this.canvas.width),e.set(r,t)),t}trim(e){e.length>240&&e.splice(0,e.length-240)}trimSamples(e){e.length>240&&e.splice(0,e.length-240)}trimRecent(e,r){let t=r-Tr,a=0;for(;a<e.length&&e[a]<t;)a++;a>0&&e.splice(0,a)}trimSamplesAt(e,r){let t=r-Tr,a=0;for(;a<e.length&&e[a].ts<t;)a++;a>0&&e.splice(0,a)}};function Pr(u){if(u.length===0)return 0;let e=u.slice().sort((t,a)=>t-a),r=e.length>>1;return e.length%2?e[r]:(e[r-1]+e[r])/2}var oe=new Float32Array(1),fe=new Uint32Array(oe.buffer);function Ci(u){oe[0]=u;let e=fe[0],r=e>>>16&32768,t=e&2147483647,a=(t>>>23)-127+15;if((e&2139095040)===2139095040)return(e&8388607)!==0?r|32256:r|31744;if(a>=31)return r|31744;if(a<=0){if(a<-10)return r;let c=t&8388607|8388608,l=14-a,f=c>>>l,d=c>>>l-1&1,_=(c&(1<<l-1)-1)!==0?1:0;return d&&(_||f&1)&&(f+=1),r|f}let o=t>>>13&1023,n=t>>>12&1,s=(t&4095)!==0?1:0,p=a<<10|o;return n&&(s||o&1)&&(p+=1,(p>>>10&31)===31)?r|31744:r|p}function lr(u){let e=(u&32768)<<16,r=(u&31744)>>>10,t=u&1023;if(r===0){if(t===0)return fe[0]=e,oe[0];let a=t,o=1;for(;(a&1024)===0;)a<<=1,o-=1;return a&=1023,fe[0]=e|o+127-15<<23|a<<13,oe[0]}return r===31?(fe[0]=e|2139095040|t<<13,oe[0]):(fe[0]=e|r+127-15<<23|t<<13,oe[0])}function Le(u){let e=new Uint16Array(u.length);for(let r=0;r<u.length;r++)e[r]=Ci(u[r]);return e}function ae(u){let e=new Float32Array(u.length);for(let r=0;r<u.length;r++)e[r]=lr(u[r]);return e}var h=class{constructor(e){i(this,"backend",e);i(this,"shader","");i(this,"pipeline");i(this,"bindGroup");i(this,"uniformDefs",[]);i(this,"uniformBuffers",{})}createUniform(e,r){this.uniformDefs.push({name:e,type:r})}setUniform(e,r){let t=this.backend.device.createBuffer({size:r.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,mappedAtCreation:!0});r instanceof Uint32Array?new Uint32Array(t.getMappedRange()).set(r):new Float32Array(t.getMappedRange()).set(r),t.unmap(),this.uniformBuffers[e]=t}defaultBindGroup(){let e=[],r=0;for(let t of this.inputs)e.push({binding:r++,resource:{buffer:t.buffer}});for(let t of this.weights)e.push({binding:r++,resource:{buffer:t.buffer}});for(let t of this.uniformDefs)e.push({binding:r++,resource:{buffer:this.uniformBuffers[t.name]}});return e.push({binding:r,resource:{buffer:this.output.buffer}}),this.backend.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:e})}defaultSetup(){let e=this.backend.device.createShaderModule({code:this.shader});this.pipeline=this.backend.device.createComputePipeline({layout:"auto",compute:{module:e,entryPoint:"main"}}),this.bindGroup=this.defaultBindGroup()}run(){let e=this.backend.device.createCommandEncoder(),r=e.beginComputePass();r.setPipeline(this.pipeline),r.setBindGroup(0,this.bindGroup),r.dispatchWorkgroups(...this.dispatch),r.end(),this.backend.device.queue.submit([e.finish()])}};var Cr=\`// Conv2d, output-channel-blocked (K=2) \\u2014 drop-in replacement for conv2d.wgsl.
//
// Identical math, layout, and output to conv2d.wgsl, but each thread computes 2
// output channel-groups (8 channels) for one pixel, loading each input vec4 ONCE
// and reusing it across both groups' mat4x4 weight blocks in registers. Half the
// register pressure of the K=4 variant (2 accumulators vs 4). Output is bit-
// identical to conv2d.wgsl (\\u22641 ULP from FMA contraction). Dispatch
// ceil(out_groups / 2) in z (see conv2d.ts).
//
// Tensor layout: NHWC, channels in vec4 groups (same as conv2d.wgsl).
// Weight layout: [K*K][out_groups][in_groups] array of mat4x4 (same as conv2d.wgsl).

struct Params {
    in_h        : u32,
    in_w        : u32,
    out_h       : u32,
    out_w       : u32,
    in_groups   : u32,   // in_channels / 4
    out_groups  : u32,   // out_channels / 4
    kernel_h    : u32,
    kernel_w    : u32,
    stride      : u32,
    pad_top     : u32,
    pad_left    : u32,
    activation  : u32,   // 0 = none, 1 = relu6, 2 = relu, 3 = leaky
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f32>>;

const KB = 2u;

fn act(v: vec4<f32>, a: u32) -> vec4<f32> {
    if (a == 1u) { return clamp(v, vec4<f32>(0.0), vec4<f32>(6.0)); }
    if (a == 2u) { return max(v, vec4<f32>(0.0)); }
    if (a == 3u) { return max(v, 0.1 * v); }   // leaky relu (slope 0.1)
    return v;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x  = gid.x;       // output column
    let y  = gid.y;       // output row
    let o0 = gid.z * KB;  // first output channel group

    if (x >= params.out_w || y >= params.out_h || o0 >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;
    // Tail handling when out_groups is odd: clamp the spare lane to o0 (valid
    // index, no OOB) and just don't write it.
    let has1 = (o0 + 1u) < O;
    let o1 = select(o0, o0 + 1u, has1);

    var acc0 = bias_buf[o0];
    var acc1 = bias_buf[o1];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let in_y_s = i32(y * params.stride + ky) - i32(params.pad_top);
            let in_x_s = i32(x * params.stride + kx) - i32(params.pad_left);

            if (in_y_s < 0 || in_x_s < 0 ||
                u32(in_y_s) >= params.in_h || u32(in_x_s) >= params.in_w) {
                continue;
            }

            let z   = ky * params.kernel_w + kx;
            let inB = u32(in_y_s) * params.in_w * I + u32(in_x_s) * I;
            let wb0 = z * O * I + o0 * I;
            let wb1 = z * O * I + o1 * I;
            for (var i = 0u; i < I; i++) {
                let iv = input_buf[inB + i];   // loaded ONCE, reused across 2 groups
                acc0 += weight_buf[wb0 + i] * iv;
                acc1 += weight_buf[wb1 + i] * iv;
            }
        }
    }

    let baseO = y * params.out_w * O + x * O;
    output_buf[baseO + o0] = act(acc0, params.activation);
    if (has1) { output_buf[baseO + o1] = act(acc1, params.activation); }
}
\`;var Wr=\`enable f16;

// Conv2d, output-channel-blocked (K=2) \\u2014 full f16. Drop-in replacement for
// conv2d_f16.wgsl. Each thread computes 2 output channel-groups for one pixel,
// loading each input vec4 ONCE and reusing it across both weight blocks. Half the
// register pressure of the K=4 variant (2 accumulators vs 4). Output is bit-
// identical to conv2d_f16.wgsl. Dispatch ceil(out_groups / 2) in z.

struct Params {
    in_h        : u32,
    in_w        : u32,
    out_h       : u32,
    out_w       : u32,
    in_groups   : u32,
    out_groups  : u32,
    kernel_h    : u32,
    kernel_w    : u32,
    stride      : u32,
    pad_top     : u32,
    pad_left    : u32,
    activation  : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x4<f16>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f16>>;

const KB = 2u;

fn act(v: vec4<f16>, a: u32) -> vec4<f16> {
    if (a == 1u) { return clamp(v, vec4<f16>(0.0h), vec4<f16>(6.0h)); }
    if (a == 2u) { return max(v, vec4<f16>(0.0h)); }
    if (a == 3u) { return max(v, 0.1h * v); }   // leaky relu (slope 0.1)
    return v;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x  = gid.x;
    let y  = gid.y;
    let o0 = gid.z * KB;

    if (x >= params.out_w || y >= params.out_h || o0 >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;
    let has1 = (o0 + 1u) < O;
    let o1 = select(o0, o0 + 1u, has1);

    var acc0 = bias_buf[o0];
    var acc1 = bias_buf[o1];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let in_y_s = i32(y * params.stride + ky) - i32(params.pad_top);
            let in_x_s = i32(x * params.stride + kx) - i32(params.pad_left);

            if (in_y_s < 0 || in_x_s < 0 ||
                u32(in_y_s) >= params.in_h || u32(in_x_s) >= params.in_w) {
                continue;
            }

            let z   = ky * params.kernel_w + kx;
            let inB = u32(in_y_s) * params.in_w * I + u32(in_x_s) * I;
            let wb0 = z * O * I + o0 * I;
            let wb1 = z * O * I + o1 * I;
            for (var i = 0u; i < I; i++) {
                let iv = input_buf[inB + i];   // loaded ONCE, reused across 2 groups
                acc0 += weight_buf[wb0 + i] * iv;
                acc1 += weight_buf[wb1 + i] * iv;
            }
        }
    }

    let baseO = y * params.out_w * O + x * O;
    output_buf[baseO + o0] = act(acc0, params.activation);
    if (has1) { output_buf[baseO + o1] = act(acc1, params.activation); }
}
\`;function C(u,e,r,t){return typeof t=="number"?Math.floor((u+2*t-e)/r)+1:t==="same"?Math.ceil(u/r):Math.floor((u-e)/r)+1}function ie(u,e,r,t){return(u-1)*r-2*t+e}function Ui(u,e,r,t){return Math.floor(Math.max((e-1)*t+r-u,0)/2)}function G(u,e,r,t,a){return typeof u=="number"?u:u==="same"?Ui(e,r,t,a):0}function m(u){return u instanceof Float32Array||u instanceof Uint16Array?u:new Float32Array(u)}function w(u){let e=Math.max(4,Math.ceil(u.length/4)*4),r=new Float32Array(e),t=u instanceof Uint16Array;for(let a=0;a<u.length;a++)r[a]=t?lr(u[a]):u[a];return r}var Fe=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Wr:Cr;let n=C(t.h,o.kernel,o.stride,o.padding),s=C(t.w,o.kernel,o.stride,o.padding),p=t.c/4,c=o.outChannels/4,l=G(o.padding,t.h,n,o.kernel,o.stride),f=G(o.padding,t.w,s,o.kernel,o.stride);this.output=r.tensor(n,s,o.outChannels),this.inputs=[t],this.weights=[r.upload(m(a.weights)),r.upload(m(a.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,n,s,p,c,o.kernel,o.kernel,o.stride,l,f,o.activation==="relu6"?1:o.activation==="relu"?2:o.activation==="leaky"?3:0])),this.defaultSetup(),this.dispatch=[Math.ceil(s/8),Math.ceil(n/8),Math.ceil(c/2)]}};var Gr=\`// ConvTranspose2d \\u2014 gather form, f32 variant. See conv_transpose2d_f16.wgsl for
// the math; this is the f32 storage build (mat4x4<f32>).

struct Params {
    in_h       : u32,
    in_w       : u32,
    out_h      : u32,
    out_w      : u32,
    in_groups  : u32,
    out_groups : u32,
    kernel_h   : u32,
    kernel_w   : u32,
    stride     : u32,
    pad_top    : u32,
    pad_left   : u32,
    activation : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f32>>;

fn act(v: vec4<f32>, a: u32) -> vec4<f32> {
    if (a == 1u) { return clamp(v, vec4<f32>(0.0), vec4<f32>(6.0)); }
    if (a == 2u) { return max(v, vec4<f32>(0.0)); }
    if (a == 3u) { return max(v, 0.1 * v); }
    return v;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let o  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || o >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;
    let s = i32(params.stride);

    var result = bias_buf[o];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let iy_num = i32(oy) + i32(params.pad_top)  - i32(ky);
            let ix_num = i32(ox) + i32(params.pad_left) - i32(kx);
            if (iy_num < 0 || ix_num < 0 || (iy_num % s) != 0 || (ix_num % s) != 0) {
                continue;
            }
            let iy = iy_num / s;
            let ix = ix_num / s;
            if (iy >= i32(params.in_h) || ix >= i32(params.in_w)) {
                continue;
            }

            let z = ky * params.kernel_w + kx;
            for (var i = 0u; i < I; i++) {
                let in_idx = u32(iy) * params.in_w * I + u32(ix) * I + i;
                let w_idx  = z * O * I + o * I + i;
                result += weight_buf[w_idx] * input_buf[in_idx];
            }
        }
    }

    output_buf[oy * params.out_w * O + ox * O + o] = act(result, params.activation);
}
\`;var Ur=\`enable f16;

// ConvTranspose2d \\u2014 gather form, full f16 variant.
// Each output (oy,ox) sums every input pixel + kernel tap that maps onto it:
//   iy = (oy + pad - ky) / stride   (must divide evenly and be in bounds)
// No explicit kernel flip \\u2014 the (oy + pad - ky) indexing carries it.
// Weight layout is IDENTICAL to conv2d (mat4x4[z][o][i], M[in_sub][out_sub] =
// W(in, out, ky, kx)), so the op uploads the flat buffer unchanged.

struct Params {
    in_h       : u32,
    in_w       : u32,
    out_h      : u32,
    out_w      : u32,
    in_groups  : u32,
    out_groups : u32,
    kernel_h   : u32,
    kernel_w   : u32,
    stride     : u32,
    pad_top    : u32,
    pad_left   : u32,
    activation : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x4<f16>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f16>>;

fn act(v: vec4<f16>, a: u32) -> vec4<f16> {
    if (a == 1u) { return clamp(v, vec4<f16>(0.0h), vec4<f16>(6.0h)); }
    if (a == 2u) { return max(v, vec4<f16>(0.0h)); }
    if (a == 3u) { return max(v, 0.1h * v); }
    return v;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let o  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || o >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;
    let s = i32(params.stride);

    var result = bias_buf[o];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let iy_num = i32(oy) + i32(params.pad_top)  - i32(ky);
            let ix_num = i32(ox) + i32(params.pad_left) - i32(kx);
            if (iy_num < 0 || ix_num < 0 || (iy_num % s) != 0 || (ix_num % s) != 0) {
                continue;
            }
            let iy = iy_num / s;
            let ix = ix_num / s;
            if (iy >= i32(params.in_h) || ix >= i32(params.in_w)) {
                continue;
            }

            let z = ky * params.kernel_w + kx;
            for (var i = 0u; i < I; i++) {
                let in_idx = u32(iy) * params.in_w * I + u32(ix) * I + i;
                let w_idx  = z * O * I + o * I + i;
                result += weight_buf[w_idx] * input_buf[in_idx];
            }
        }
    }

    output_buf[oy * params.out_w * O + ox * O + o] = act(result, params.activation);
}
\`;var Ee=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Ur:Gr;let n=ie(t.h,o.kernel,o.stride,o.padding),s=ie(t.w,o.kernel,o.stride,o.padding),p=t.c/4,c=o.outChannels/4;this.output=r.tensor(n,s,o.outChannels),this.inputs=[t],this.weights=[r.upload(m(a.weights)),r.upload(m(a.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,n,s,p,c,o.kernel,o.kernel,o.stride,o.padding,o.padding,o.activation==="relu6"?1:o.activation==="relu"?2:o.activation==="leaky"?3:0])),this.defaultSetup(),this.dispatch=[Math.ceil(s/8),Math.ceil(n/8),c]}};var Br=\`// Depthwise Conv2d \\u2014 groups = in_channels (each channel convolved independently).
//
// Weight layout: [K*K][channel_groups] array of vec4
//   weight index = (ky*kernel_w + kx) * channel_groups + c
//   Each vec4 holds the kernel weight for 4 consecutive channels at one spatial position.
//   Operation: element-wise multiply (each input channel multiplied by its own weight).
//
// Contrast with conv2d.wgsl which uses mat4x4 (dense cross-channel mixing).
// 4\\xD7 smaller weight buffer than a diagonal mat4x4 representation (4 floats vs 16 per group).
//
// Padding model: only \\\`pad_top\\\` and \\\`pad_left\\\` are applied to the input offset.
// Asymmetric SAME padding is handled implicitly via the in_h/in_w bounds check.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,   // channels / 4
    kernel_h       : u32,
    kernel_w       : u32,
    stride         : u32,
    pad_top        : u32,
    pad_left       : u32,
    apply_relu6    : u32,
    _pad0          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;  // output column
    let y = gid.y;  // output row
    let c = gid.z;  // channel group

    if (x >= params.out_w || y >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let C = params.channel_groups;

    var result = bias_buf[c];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let in_y_s = i32(y * params.stride + ky) - i32(params.pad_top);
            let in_x_s = i32(x * params.stride + kx) - i32(params.pad_left);

            if (in_y_s < 0 || in_x_s < 0 ||
                u32(in_y_s) >= params.in_h || u32(in_x_s) >= params.in_w) {
                continue;
            }

            let in_y = u32(in_y_s);
            let in_x = u32(in_x_s);
            let z    = ky * params.kernel_w + kx;

            let in_idx = in_y * params.in_w * C + in_x * C + c;
            let w_idx  = z * C + c;
            result += weight_buf[w_idx] * input_buf[in_idx];
        }
    }

    if (params.apply_relu6 == 1u) {
        result = clamp(result, vec4<f32>(0.0), vec4<f32>(6.0));
    }

    let out_idx = y * params.out_w * C + x * C + c;
    output_buf[out_idx] = result;
}
\`;var Sr=\`enable f16;

// Depthwise conv2d \\u2014 full f16 variant. All buffers f16.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    kernel_h       : u32,
    kernel_w       : u32,
    stride         : u32,
    pad_top        : u32,
    pad_left       : u32,
    apply_relu6    : u32,
    _pad0          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let c = gid.z;

    if (x >= params.out_w || y >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let C = params.channel_groups;

    var result = bias_buf[c];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let in_y_s = i32(y * params.stride + ky) - i32(params.pad_top);
            let in_x_s = i32(x * params.stride + kx) - i32(params.pad_left);

            if (in_y_s < 0 || in_x_s < 0 ||
                u32(in_y_s) >= params.in_h || u32(in_x_s) >= params.in_w) {
                continue;
            }

            let in_y = u32(in_y_s);
            let in_x = u32(in_x_s);
            let z    = ky * params.kernel_w + kx;

            let in_idx = in_y * params.in_w * C + in_x * C + c;
            let w_idx  = z * C + c;
            result += weight_buf[w_idx] * input_buf[in_idx];
        }
    }

    if (params.apply_relu6 == 1u) {
        result = clamp(result, vec4<f16>(0.0h), vec4<f16>(6.0h));
    }

    output_buf[y * params.out_w * C + x * C + c] = result;
}
\`;var Re=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Sr:Br;let n=C(t.h,o.kernel,o.stride,o.padding),s=C(t.w,o.kernel,o.stride,o.padding),p=t.c/4,c=G(o.padding,t.h,n,o.kernel,o.stride),l=G(o.padding,t.w,s,o.kernel,o.stride);this.output=r.tensor(n,s,t.c),this.inputs=[t],this.weights=[r.upload(m(a.weights)),r.upload(m(a.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,n,s,p,o.kernel,o.kernel,o.stride,c,l,o.activation==="relu6"?1:0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(s/8),Math.ceil(n/8),p]}};var Ar=\`// Element-wise add of two tensors \\u2014 used for residual connections in MBConv blocks.
// Operates on the flat float buffer directly; layout is irrelevant for a pure element-wise op.

struct Params {
    size  : u32,   // total number of f32 elements
    _pad0 : u32,
    _pad1 : u32,
    _pad2 : u32,
}

@group(0) @binding(0) var<storage, read>       input_a : array<f32>;
@group(0) @binding(1) var<storage, read>       input_b : array<f32>;
@group(0) @binding(2) var<uniform>             params  : Params;
@group(0) @binding(3) var<storage, read_write> output  : array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.size) { return; }
    output[idx] = input_a[idx] + input_b[idx];
}
\`;var Lr=\`enable f16;

// Element-wise add \\u2014 full f16 variant.
// array<f16> is binary-compatible with array<vec4<f16>> written by the f16 conv shaders.

struct Params {
    size  : u32,
    _pad0 : u32,
    _pad1 : u32,
    _pad2 : u32,
}

@group(0) @binding(0) var<storage, read>       input_a : array<f16>;
@group(0) @binding(1) var<storage, read>       input_b : array<f16>;
@group(0) @binding(2) var<uniform>             params  : Params;
@group(0) @binding(3) var<storage, read_write> output  : array<f16>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.size) { return; }
    output[idx] = input_a[idx] + input_b[idx];
}
\`;var De=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Lr:Ar;let o=t.h*t.w*t.c;this.output=r.tensor(t.h,t.w,t.c),this.inputs=[t,a],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([o,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(o/256),1,1]}};var Fr=\`// Element-wise sigmoid: output = 1 / (1 + exp(-x)).
// Operates on packed vec4 buffers (NHWC layout). exp() and arithmetic are element-wise on vec4.

struct Params {
    n_groups : u32,   // total vec4 elements (H * W * channel_groups)
    _pad0    : u32,
    _pad1    : u32,
    _pad2    : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.n_groups) { return; }
    output_buf[idx] = 1.0 / (1.0 + exp(-input_buf[idx]));
}
\`;var Er=\`enable f16;

// Sigmoid \\u2014 full f16 variant.

struct Params {
    n_groups : u32,
    _pad0    : u32,
    _pad1    : u32,
    _pad2    : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.n_groups) { return; }
    let x = vec4<f32>(input_buf[idx]);
    output_buf[idx] = vec4<f16>(1.0 / (1.0 + exp(-x)));
}
\`;var Oe=class extends h{constructor(r,t){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Er:Fr;let a=t.h*t.w*(t.c/4);this.output=r.tensor(t.h,t.w,t.c),this.inputs=[t],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([a,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(a/256),1,1]}};var Rr=\`// Element-wise tanh \\u2014 used by ConvGRU candidate activation.
// Operates on packed vec4 buffers (NHWC layout). tanh() is element-wise on vec4.

struct Params {
    n_groups : u32,
    _pad0    : u32,
    _pad1    : u32,
    _pad2    : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.n_groups) { return; }
    output_buf[idx] = tanh(input_buf[idx]);
}
\`;var Dr=\`enable f16;

// Tanh \\u2014 full f16 variant.

struct Params {
    n_groups : u32,
    _pad0    : u32,
    _pad1    : u32,
    _pad2    : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.n_groups) { return; }
    let x = vec4<f32>(input_buf[idx]);
    output_buf[idx] = vec4<f16>(tanh(x));
}
\`;var Ie=class extends h{constructor(r,t){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Dr:Rr;let a=t.h*t.w*(t.c/4);this.output=r.tensor(t.h,t.w,t.c),this.inputs=[t],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([a,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(a/256),1,1]}};var Or=\`// Element-wise multiply \\u2014 used in ConvGRU for r \\u2299 h_prev.
// Same flat-float layout as add.wgsl.

struct Params {
    size  : u32,
    _pad0 : u32,
    _pad1 : u32,
    _pad2 : u32,
}

@group(0) @binding(0) var<storage, read>       input_a : array<f32>;
@group(0) @binding(1) var<storage, read>       input_b : array<f32>;
@group(0) @binding(2) var<uniform>             params  : Params;
@group(0) @binding(3) var<storage, read_write> output  : array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.size) { return; }
    output[idx] = input_a[idx] * input_b[idx];
}
\`;var Ir=\`enable f16;

// Element-wise multiply \\u2014 full f16 variant.
// array<f16> is binary-compatible with array<vec4<f16>> written by the f16 conv shaders.

struct Params {
    size  : u32,
    _pad0 : u32,
    _pad1 : u32,
    _pad2 : u32,
}

@group(0) @binding(0) var<storage, read>       input_a : array<f16>;
@group(0) @binding(1) var<storage, read>       input_b : array<f16>;
@group(0) @binding(2) var<uniform>             params  : Params;
@group(0) @binding(3) var<storage, read_write> output  : array<f16>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= params.size) { return; }
    output[idx] = input_a[idx] * input_b[idx];
}
\`;var Me=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Ir:Or;let o=t.h*t.w*t.c;this.output=r.tensor(t.h,t.w,t.c),this.inputs=[t,a],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([o,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(o/256),1,1]}};var Mr=\`// Bilinear gather-warp (f32). See warp_f16.wgsl for the math.

struct Params {
    h          : u32,
    w          : u32,
    flow_scale : f32,
    groups     : u32,   // source/output channel groups (c/4); flow is always 1 group
}

@group(0) @binding(0) var<storage, read>       source_buf : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       flow_buf   : array<vec4<f32>>;
@group(0) @binding(2) var<uniform>             params     : Params;
@group(0) @binding(3) var<storage, read_write> output_buf : array<vec4<f32>>;

fn samp(x: i32, y: i32, W: i32, H: i32, g: u32) -> vec4<f32> {
    let cx = clamp(x, 0, W - 1);
    let cy = clamp(y, 0, H - 1);
    return source_buf[(u32(cy) * u32(W) + u32(cx)) * params.groups + g];
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let g = gid.z;
    if (x >= params.w || y >= params.h || g >= params.groups) { return; }

    let W = i32(params.w);
    let H = i32(params.h);

    let f  = flow_buf[y * params.w + x].xy;
    let sx = clamp(f32(x) + params.flow_scale * f.x, 0.0, f32(W - 1));
    let sy = clamp(f32(y) + params.flow_scale * f.y, 0.0, f32(H - 1));

    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);

    let top = mix(samp(x0, y0, W, H, g), samp(x0 + 1, y0, W, H, g), tx);
    let bot = mix(samp(x0, y0 + 1, W, H, g), samp(x0 + 1, y0 + 1, W, H, g), tx);
    output_buf[(y * params.w + x) * params.groups + g] = mix(top, bot, ty);
}
\`;var zr=\`enable f16;

// Bilinear gather-warp (f16 storage, f32 coordinate math). For each output pixel
// p, sample the source at p + flow_scale\\xB7flow[p].xy and bilinearly interpolate,
// clamping the sample to the edge (border-replicate). Source + flow are 4-ch
// (1 group), same resolution; flow vector is in .xy.

struct Params {
    h          : u32,
    w          : u32,
    flow_scale : f32,
    groups     : u32,   // source/output channel groups (c/4); flow is always 1 group
}

@group(0) @binding(0) var<storage, read>       source_buf : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       flow_buf   : array<vec4<f16>>;
@group(0) @binding(2) var<uniform>             params     : Params;
@group(0) @binding(3) var<storage, read_write> output_buf : array<vec4<f16>>;

fn samp(x: i32, y: i32, W: i32, H: i32, g: u32) -> vec4<f32> {
    let cx = clamp(x, 0, W - 1);
    let cy = clamp(y, 0, H - 1);
    return vec4<f32>(source_buf[(u32(cy) * u32(W) + u32(cx)) * params.groups + g]);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let g = gid.z;
    if (x >= params.w || y >= params.h || g >= params.groups) { return; }

    let W = i32(params.w);
    let H = i32(params.h);
    

    let f  = vec2<f32>(flow_buf[y * params.w + x].xy);
    let sx = clamp(f32(x) + params.flow_scale * f.x, 0.0, f32(W - 1));
    let sy = clamp(f32(y) + params.flow_scale * f.y, 0.0, f32(H - 1));

    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);

    let top = mix(samp(x0, y0, W, H, g), samp(x0 + 1, y0, W, H, g), tx);
    let bot = mix(samp(x0, y0 + 1, W, H, g), samp(x0 + 1, y0 + 1, W, H, g), tx);
    output_buf[(y * params.w + x) * params.groups + g] = vec4<f16>(mix(top, bot, ty));
}
\`;var ze=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?zr:Mr,this.output=r.tensor(t.h,t.w,t.c),this.inputs=[t,a],this.createUniform("params","Params");let n=new Uint32Array(4);n[0]=t.h,n[1]=t.w,new Float32Array(n.buffer)[2]=o.flowScale,n[3]=t.c/4,this.setUniform("params",n),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),t.c/4]}};var Hr=\`// Face-box decode from 5-keypoint heatmaps (f32). One workgroup: threads 0-4
// each soft-argmax one channel (peak + windowed centroid \\u2014 hard argmax snaps
// to whole cells and jitters the crop); thread 0 combines the keypoint hull
// into a pixel-square box.
//
// Output (1 vec4): (cx, cy, halfSide, score) in FRAME FRACTIONS \\u2014 halfSide as
// a fraction of frame WIDTH. The heatmap grid shares the frame's aspect, so
// squaring in grid-cell px squares in frame px. score = min keypoint peak,
// forced to 0 if any peak < thresh.

struct Params {
    h         : u32,
    w         : u32,
    win       : i32,
    thresh    : f32,
    box_scale : f32,
}

@group(0) @binding(0) var<storage, read>       hm_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params  : Params;
@group(0) @binding(2) var<storage, read_write> out_buf : array<vec4<f32>>;

var<workgroup> kp_x : array<f32, 5>;   // continuous cell coords
var<workgroup> kp_y : array<f32, 5>;
var<workgroup> kp_s : array<f32, 5>;   // peak scores

fn hm_at(x: u32, y: u32, k: u32) -> f32 {
    var v = hm_buf[(y * params.w + x) * 2u + (k / 4u)];   // 8ch \\u2192 2 vec4 groups
    return v[k % 4u];
}

@compute @workgroup_size(5, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
    let k = lid.x;

    // Peak.
    var peak = -1.0;
    var pr = 0u;
    var pc = 0u;
    for (var y = 0u; y < params.h; y++) {
        for (var x = 0u; x < params.w; x++) {
            let v = hm_at(x, y, k);
            if (v > peak) { peak = v; pr = y; pc = x; }
        }
    }

    // Windowed soft-argmax centroid around the peak.
    let r0 = u32(max(0, i32(pr) - params.win));
    let r1 = u32(min(i32(params.h), i32(pr) + params.win + 1));
    let c0 = u32(max(0, i32(pc) - params.win));
    let c1 = u32(min(i32(params.w), i32(pc) + params.win + 1));
    var wsum = 0.0;
    var sy = 0.0;
    var sx = 0.0;
    for (var y = r0; y < r1; y++) {
        for (var x = c0; x < c1; x++) {
            let v = hm_at(x, y, k);
            wsum += v;
            sy += v * f32(y);
            sx += v * f32(x);
        }
    }
    wsum = max(wsum, 1e-6);
    kp_x[k] = sx / wsum;
    kp_y[k] = sy / wsum;
    kp_s[k] = peak;
    workgroupBarrier();

    if (k != 0u) { return; }

    // Hull over the 5 keypoints, in grid-cell px.
    var x0 = 1e9; var x1 = -1e9;
    var y0 = 1e9; var y1 = -1e9;
    var score = 1e9;
    for (var i = 0u; i < 5u; i++) {
        x0 = min(x0, kp_x[i]); x1 = max(x1, kp_x[i]);
        y0 = min(y0, kp_y[i]); y1 = max(y1, kp_y[i]);
        score = min(score, kp_s[i]);
    }
    if (score < params.thresh) { score = 0.0; }

    // Square box: side = boxScale \\xD7 hull long side (grid px == frame-px aspect).
    let half_px = 0.5 * params.box_scale * max(x1 - x0, y1 - y0);
    let cx = ((x0 + x1) * 0.5 + 0.5) / f32(params.w);   // +0.5: cell \\u2192 center
    let cy = ((y0 + y1) * 0.5 + 0.5) / f32(params.h);
    out_buf[0] = vec4<f32>(cx, cy, half_px / f32(params.w), score);
}
\`;var Nr=\`enable f16;

// Face-box decode from 5-keypoint heatmaps (f16 storage, f32 math). One workgroup: threads 0-4
// each soft-argmax one channel (peak + windowed centroid \\u2014 hard argmax snaps
// to whole cells and jitters the crop); thread 0 combines the keypoint hull
// into a pixel-square box.
//
// Output (1 vec4): (cx, cy, halfSide, score) in FRAME FRACTIONS \\u2014 halfSide as
// a fraction of frame WIDTH. The heatmap grid shares the frame's aspect, so
// squaring in grid-cell px squares in frame px. score = min keypoint peak,
// forced to 0 if any peak < thresh.

struct Params {
    h         : u32,
    w         : u32,
    win       : i32,
    thresh    : f32,
    box_scale : f32,
}

@group(0) @binding(0) var<storage, read>       hm_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params  : Params;
@group(0) @binding(2) var<storage, read_write> out_buf : array<vec4<f16>>;

var<workgroup> kp_x : array<f32, 5>;   // continuous cell coords
var<workgroup> kp_y : array<f32, 5>;
var<workgroup> kp_s : array<f32, 5>;   // peak scores

fn hm_at(x: u32, y: u32, k: u32) -> f32 {
    var v = hm_buf[(y * params.w + x) * 2u + (k / 4u)];   // 8ch \\u2192 2 vec4 groups
    return f32(v[k % 4u]);
}

@compute @workgroup_size(5, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
    let k = lid.x;

    // Peak.
    var peak = -1.0;
    var pr = 0u;
    var pc = 0u;
    for (var y = 0u; y < params.h; y++) {
        for (var x = 0u; x < params.w; x++) {
            let v = hm_at(x, y, k);
            if (v > peak) { peak = v; pr = y; pc = x; }
        }
    }

    // Windowed soft-argmax centroid around the peak.
    let r0 = u32(max(0, i32(pr) - params.win));
    let r1 = u32(min(i32(params.h), i32(pr) + params.win + 1));
    let c0 = u32(max(0, i32(pc) - params.win));
    let c1 = u32(min(i32(params.w), i32(pc) + params.win + 1));
    var wsum = 0.0;
    var sy = 0.0;
    var sx = 0.0;
    for (var y = r0; y < r1; y++) {
        for (var x = c0; x < c1; x++) {
            let v = hm_at(x, y, k);
            wsum += v;
            sy += v * f32(y);
            sx += v * f32(x);
        }
    }
    wsum = max(wsum, 1e-6);
    kp_x[k] = sx / wsum;
    kp_y[k] = sy / wsum;
    kp_s[k] = peak;
    workgroupBarrier();

    if (k != 0u) { return; }

    // Hull over the 5 keypoints, in grid-cell px.
    var x0 = 1e9; var x1 = -1e9;
    var y0 = 1e9; var y1 = -1e9;
    var score = 1e9;
    for (var i = 0u; i < 5u; i++) {
        x0 = min(x0, kp_x[i]); x1 = max(x1, kp_x[i]);
        y0 = min(y0, kp_y[i]); y1 = max(y1, kp_y[i]);
        score = min(score, kp_s[i]);
    }
    if (score < params.thresh) { score = 0.0; }

    // Square box: side = boxScale \\xD7 hull long side (grid px == frame-px aspect).
    let half_px = 0.5 * params.box_scale * max(x1 - x0, y1 - y0);
    let cx = ((x0 + x1) * 0.5 + 0.5) / f32(params.w);   // +0.5: cell \\u2192 center
    let cy = ((y0 + y1) * 0.5 + 0.5) / f32(params.h);
    out_buf[0] = vec4<f16>(vec4<f32>(cx, cy, half_px / f32(params.w), score));
}
\`;var He=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch",[1,1,1]);i(this,"shader");if(t.c!==8)throw new Error(\`FaceBoxFromHeatmaps: expected 8-ch heatmaps (5 real), got \${t.c}\`);this.shader=r.dtype==="f16"?Nr:Hr,this.output=r.tensor(1,1,4),this.inputs=[t],this.createUniform("params","Params");let o=new Uint32Array(5);o[0]=t.h,o[1]=t.w,new Int32Array(o.buffer)[2]=a.win;let n=new Float32Array(o.buffer);n[3]=a.thresh,n[4]=a.boxScale,this.setUniform("params",o),this.defaultSetup()}};var Vr=\`// MULTI-FACE box decode from 5-keypoint heatmaps (f32) \\u2192 1\\xD7K\\xD74 box tensor.
// The multi-face sibling of face_box.wgsl (which is single-face: one global
// argmax per channel + hull, so two faces merge into one box).
//
// Stage 1 (threads 0-4, one channel each): 3\\xD73 local-maximum candidates above
//   thresh, top-MAX_CAND by peak score, refined with the windowed soft-argmax
//   centroid (the required decode \\u2014 hard argmax cell-snaps and jitters the
//   crop), deduped by refined position.
// Stage 2 (thread 0): every (L-eye, R-eye) candidate pair is a face hypothesis.
//   The pair fixes the face's center, scale (interocular distance) and roll, so
//   nose + mouth corners are PREDICTED from the ArcFace canonical template and
//   matched against candidates within tol \\xD7 interocular. Cross-pairing (face A's
//   left eye with face B's right eye) survives stage 1 but dies here: the
//   implied scale is wrong and there's no nose/mouth support where the template
//   says there should be.
// Stage 3/4 (thread 0): score = mean matched peak \\u2212 LAMBDA \\xB7 mean normalized
//   residual; greedy NMS rejects any hypothesis reusing a consumed candidate.
//
// Output slot i: (cx, cy, halfSide, score) in FRAME FRACTIONS, halfSide as a
// fraction of frame WIDTH (the grid shares the frame's aspect, so squaring in
// grid px squares in frame px). Slots past the face count are zeroed \\u2014 score 0
// means "no face", which every consumer already gates on.
//
// CPU reference (kept in sync deliberately): sdk/demo/face.ts findCandidates /
// groupFaces.

struct Params {
    h         : u32,
    w         : u32,
    win       : i32,
    thresh    : f32,
    box_scale : f32,
    max_faces : u32,
    tol       : f32,
}

@group(0) @binding(0) var<storage, read>       hm_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params  : Params;
@group(0) @binding(2) var<storage, read_write> out_buf : array<vec4<f32>>;

const N_KP     : u32 = 5u;
const MAX_CAND : u32 = 5u;    // candidates per channel
const LAMBDA   : f32 = 0.5;   // geometric-residual weight
const MIN_SEP  : f32 = 1.0;   // cells \\u2014 closer refined centroids are one blob
const MIN_EYE  : f32 = 1.0;   // cells \\u2014 below this the grid can't resolve a pair

// Candidate table, N_KP \\xD7 MAX_CAND, filled by stage 1 (thread k owns row k).
var<workgroup> c_x : array<f32, 25>;   // refined cell coords
var<workgroup> c_y : array<f32, 25>;
var<workgroup> c_s : array<f32, 25>;   // peak scores
var<workgroup> c_n : array<u32, 5>;    // candidates found per channel

fn hm_at(x: u32, y: u32, k: u32) -> f32 {
    var v = hm_buf[(y * params.w + x) * 2u + (k / 4u)];   // 8ch \\u2192 2 vec4 groups
    return v[k % 4u];
}

// ArcFace canonical 5-point template in the EYE FRAME: origin = L-eye, +u along
// the L-eye\\u2192R-eye vector, +w perpendicular (image-down for an upright face),
// both normalized by interocular distance. t: 0 = nose, 1 = L-mouth, 2 = R-mouth.
fn tmpl_u(t: u32) -> f32 {
    if (t == 0u) { return 0.50002; }
    if (t == 1u) { return 0.08598; }
    return 0.91410;
}
fn tmpl_w(t: u32) -> f32 {
    if (t == 0u) { return 0.57150; }
    return 1.15462;   // both mouth corners sit at the same depth
}

@compute @workgroup_size(5, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
    let k = lid.x;

    // \\u2500\\u2500 stage 1: local-maximum candidates for channel k \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    var pr : array<u32, 5>;
    var pc : array<u32, 5>;
    var ps : array<f32, 5>;
    var n  = 0u;

    for (var y = 0u; y < params.h; y++) {
        for (var x = 0u; x < params.w; x++) {
            let v = hm_at(x, y, k);
            if (v < params.thresh) { continue; }

            // 3\\xD73 strict local max. The index tiebreak keeps exactly one member
            // of a plateau (f16 heatmaps produce exact ties).
            var is_max = true;
            for (var dy: i32 = -1; dy <= 1; dy++) {
                for (var dx: i32 = -1; dx <= 1; dx++) {
                    if (dx == 0 && dy == 0) { continue; }
                    let rr = i32(y) + dy;
                    let cc = i32(x) + dx;
                    if (rr < 0 || rr >= i32(params.h) || cc < 0 || cc >= i32(params.w)) { continue; }
                    let u = hm_at(u32(cc), u32(rr), k);
                    if (u > v || (u == v && u32(rr) * params.w + u32(cc) < y * params.w + x)) {
                        is_max = false;
                    }
                }
            }
            if (!is_max) { continue; }

            // Insert into the score-ordered top-MAX_CAND list.
            var slot = n;
            if (n == MAX_CAND) {
                if (v <= ps[MAX_CAND - 1u]) { continue; }
                slot = MAX_CAND - 1u;
            } else {
                n = n + 1u;
            }
            while (slot > 0u && ps[slot - 1u] < v) {
                ps[slot] = ps[slot - 1u];
                pr[slot] = pr[slot - 1u];
                pc[slot] = pc[slot - 1u];
                slot = slot - 1u;
            }
            ps[slot] = v; pr[slot] = y; pc[slot] = x;
        }
    }

    // Refine each peak with the windowed soft-argmax centroid, dropping any that
    // lands on top of a higher-scoring one (two maxima on a single blob).
    var m = 0u;
    for (var i = 0u; i < n; i++) {
        var rx = f32(pc[i]);
        var ry = f32(pr[i]);
        if (params.win > 0) {
            let r0 = u32(max(0, i32(pr[i]) - params.win));
            let r1 = u32(min(i32(params.h), i32(pr[i]) + params.win + 1));
            let c0 = u32(max(0, i32(pc[i]) - params.win));
            let c1 = u32(min(i32(params.w), i32(pc[i]) + params.win + 1));
            var wsum = 0.0; var sy = 0.0; var sx = 0.0;
            for (var y = r0; y < r1; y++) {
                for (var x = c0; x < c1; x++) {
                    let v = hm_at(x, y, k);
                    wsum += v; sy += v * f32(y); sx += v * f32(x);
                }
            }
            wsum = max(wsum, 1e-6);
            rx = sx / wsum; ry = sy / wsum;
        }
        var dup = false;
        for (var j = 0u; j < m; j++) {
            let dx = c_x[k * MAX_CAND + j] - rx;
            let dy = c_y[k * MAX_CAND + j] - ry;
            if (sqrt(dx * dx + dy * dy) < MIN_SEP) { dup = true; }
        }
        if (dup) { continue; }
        c_x[k * MAX_CAND + m] = rx;
        c_y[k * MAX_CAND + m] = ry;
        c_s[k * MAX_CAND + m] = ps[i];
        m = m + 1u;
    }
    c_n[k] = m;

    workgroupBarrier();
    if (k != 0u) { return; }

    // \\u2500\\u2500 stage 2: eye-pair hypotheses \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    var h_score : array<f32, 25>;
    var h_kp    : array<i32, 125>;   // hypothesis q, channel t \\u2192 candidate idx (-1 = unmatched)
    var nh = 0u;
    let max_eye = f32(params.w) * 0.45;   // a face wider than ~half the frame

    for (var i = 0u; i < c_n[0]; i++) {
        for (var j = 0u; j < c_n[1]; j++) {
            let ax = c_x[i];
            let ay = c_y[i];
            let bx = c_x[MAX_CAND + j];
            let by = c_y[MAX_CAND + j];
            let evx = bx - ax;
            let evy = by - ay;
            let len = sqrt(evx * evx + evy * evy);
            if (len < MIN_EYE || len > max_eye) { continue; }
            let ex = vec2<f32>(evx / len, evy / len);
            let ey = vec2<f32>(-ex.y, ex.x);

            var sc      = c_s[i] + c_s[MAX_CAND + j];
            var resid   = 0.0;
            var n_match = 2u;
            var mouths  = 0u;
            var nose    = -1;
            var mo      = array<i32, 2>(-1, -1);

            for (var t = 0u; t < 3u; t++) {
                let kk = t + 2u;
                let px = ax + len * (tmpl_u(t) * ex.x + tmpl_w(t) * ey.x);
                let py = ay + len * (tmpl_u(t) * ex.y + tmpl_w(t) * ey.y);
                var best   = -1;
                var best_d = params.tol * len;
                for (var q = 0u; q < c_n[kk]; q++) {
                    let dx = c_x[kk * MAX_CAND + q] - px;
                    let dy = c_y[kk * MAX_CAND + q] - py;
                    let d  = sqrt(dx * dx + dy * dy);
                    if (d < best_d) { best_d = d; best = i32(q); }
                }
                if (best < 0) { continue; }
                sc += c_s[kk * MAX_CAND + u32(best)];
                resid += best_d / len;
                n_match += 1u;
                if (t == 0u) { nose = best; } else { mo[t - 1u] = best; mouths += 1u; }
            }
            // Support floor: a hypothesis needs the nose and at least one mouth
            // corner, otherwise two stray eye peaks become a face.
            if (nose < 0 || mouths < 1u) { continue; }

            h_score[nh] = sc / f32(n_match) - LAMBDA * (resid / f32(n_match - 2u));
            h_kp[nh * N_KP + 0u] = i32(i);
            h_kp[nh * N_KP + 1u] = i32(j);
            h_kp[nh * N_KP + 2u] = nose;
            h_kp[nh * N_KP + 3u] = mo[0];
            h_kp[nh * N_KP + 4u] = mo[1];
            nh = nh + 1u;
        }
    }

    // \\u2500\\u2500 stage 3/4: greedy NMS by score \\u2192 boxes \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    var used : array<bool, 25>;
    for (var i = 0u; i < N_KP * MAX_CAND; i++) { used[i] = false; }
    var out_n = 0u;

    for (var iter = 0u; iter < 25u; iter++) {
        if (out_n >= params.max_faces) { break; }

        // Best remaining hypothesis. Consumed ones are marked -1e9; real scores
        // are bounded well above -1e8 (mean peak \\u2208 [0,1] minus LAMBDA\\xB7tol).
        var best   = -1;
        var best_s = -1e8;
        for (var q = 0u; q < nh; q++) {
            if (h_score[q] > best_s) { best_s = h_score[q]; best = i32(q); }
        }
        if (best < 0) { break; }
        let q = u32(best);
        h_score[q] = -1e9;

        var clash = false;
        for (var t = 0u; t < N_KP; t++) {
            let ci = h_kp[q * N_KP + t];
            if (ci < 0) { continue; }
            if (used[t * MAX_CAND + u32(ci)]) { clash = true; }
        }
        if (clash) { continue; }

        // Hull over this face's matched keypoints, in grid cells.
        var x0 = 1e9; var x1 = -1e9;
        var y0 = 1e9; var y1 = -1e9;
        var score = 1e9;
        for (var t = 0u; t < N_KP; t++) {
            let ci = h_kp[q * N_KP + t];
            if (ci < 0) { continue; }
            let e = t * MAX_CAND + u32(ci);
            used[e] = true;
            x0 = min(x0, c_x[e]); x1 = max(x1, c_x[e]);
            y0 = min(y0, c_y[e]); y1 = max(y1, c_y[e]);
            score = min(score, c_s[e]);
        }

        let half_px = 0.5 * params.box_scale * max(x1 - x0, y1 - y0);
        let cx = ((x0 + x1) * 0.5 + 0.5) / f32(params.w);   // +0.5: cell \\u2192 center
        let cy = ((y0 + y1) * 0.5 + 0.5) / f32(params.h);
        out_buf[out_n] = vec4<f32>(cx, cy, half_px / f32(params.w), score);
        out_n = out_n + 1u;
    }

    for (var i = out_n; i < params.max_faces; i++) {
        out_buf[i] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }
}
\`;var Xr=\`enable f16;

// MULTI-FACE box decode from 5-keypoint heatmaps (f16 storage, f32 math) \\u2192 1\\xD7K\\xD74 box tensor.
// The multi-face sibling of face_box.wgsl (which is single-face: one global
// argmax per channel + hull, so two faces merge into one box).
//
// Stage 1 (threads 0-4, one channel each): 3\\xD73 local-maximum candidates above
//   thresh, top-MAX_CAND by peak score, refined with the windowed soft-argmax
//   centroid (the required decode \\u2014 hard argmax cell-snaps and jitters the
//   crop), deduped by refined position.
// Stage 2 (thread 0): every (L-eye, R-eye) candidate pair is a face hypothesis.
//   The pair fixes the face's center, scale (interocular distance) and roll, so
//   nose + mouth corners are PREDICTED from the ArcFace canonical template and
//   matched against candidates within tol \\xD7 interocular. Cross-pairing (face A's
//   left eye with face B's right eye) survives stage 1 but dies here: the
//   implied scale is wrong and there's no nose/mouth support where the template
//   says there should be.
// Stage 3/4 (thread 0): score = mean matched peak \\u2212 LAMBDA \\xB7 mean normalized
//   residual; greedy NMS rejects any hypothesis reusing a consumed candidate.
//
// Output slot i: (cx, cy, halfSide, score) in FRAME FRACTIONS, halfSide as a
// fraction of frame WIDTH (the grid shares the frame's aspect, so squaring in
// grid px squares in frame px). Slots past the face count are zeroed \\u2014 score 0
// means "no face", which every consumer already gates on.
//
// CPU reference (kept in sync deliberately): sdk/demo/face.ts findCandidates /
// groupFaces.

struct Params {
    h         : u32,
    w         : u32,
    win       : i32,
    thresh    : f32,
    box_scale : f32,
    max_faces : u32,
    tol       : f32,
}

@group(0) @binding(0) var<storage, read>       hm_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params  : Params;
@group(0) @binding(2) var<storage, read_write> out_buf : array<vec4<f16>>;

const N_KP     : u32 = 5u;
const MAX_CAND : u32 = 5u;    // candidates per channel
const LAMBDA   : f32 = 0.5;   // geometric-residual weight
const MIN_SEP  : f32 = 1.0;   // cells \\u2014 closer refined centroids are one blob
const MIN_EYE  : f32 = 1.0;   // cells \\u2014 below this the grid can't resolve a pair

// Candidate table, N_KP \\xD7 MAX_CAND, filled by stage 1 (thread k owns row k).
var<workgroup> c_x : array<f32, 25>;   // refined cell coords
var<workgroup> c_y : array<f32, 25>;
var<workgroup> c_s : array<f32, 25>;   // peak scores
var<workgroup> c_n : array<u32, 5>;    // candidates found per channel

fn hm_at(x: u32, y: u32, k: u32) -> f32 {
    var v = hm_buf[(y * params.w + x) * 2u + (k / 4u)];   // 8ch \\u2192 2 vec4 groups
    return f32(v[k % 4u]);
}

// ArcFace canonical 5-point template in the EYE FRAME: origin = L-eye, +u along
// the L-eye\\u2192R-eye vector, +w perpendicular (image-down for an upright face),
// both normalized by interocular distance. t: 0 = nose, 1 = L-mouth, 2 = R-mouth.
fn tmpl_u(t: u32) -> f32 {
    if (t == 0u) { return 0.50002; }
    if (t == 1u) { return 0.08598; }
    return 0.91410;
}
fn tmpl_w(t: u32) -> f32 {
    if (t == 0u) { return 0.57150; }
    return 1.15462;   // both mouth corners sit at the same depth
}

@compute @workgroup_size(5, 1, 1)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
    let k = lid.x;

    // \\u2500\\u2500 stage 1: local-maximum candidates for channel k \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    var pr : array<u32, 5>;
    var pc : array<u32, 5>;
    var ps : array<f32, 5>;
    var n  = 0u;

    for (var y = 0u; y < params.h; y++) {
        for (var x = 0u; x < params.w; x++) {
            let v = hm_at(x, y, k);
            if (v < params.thresh) { continue; }

            // 3\\xD73 strict local max. The index tiebreak keeps exactly one member
            // of a plateau (f16 heatmaps produce exact ties).
            var is_max = true;
            for (var dy: i32 = -1; dy <= 1; dy++) {
                for (var dx: i32 = -1; dx <= 1; dx++) {
                    if (dx == 0 && dy == 0) { continue; }
                    let rr = i32(y) + dy;
                    let cc = i32(x) + dx;
                    if (rr < 0 || rr >= i32(params.h) || cc < 0 || cc >= i32(params.w)) { continue; }
                    let u = hm_at(u32(cc), u32(rr), k);
                    if (u > v || (u == v && u32(rr) * params.w + u32(cc) < y * params.w + x)) {
                        is_max = false;
                    }
                }
            }
            if (!is_max) { continue; }

            // Insert into the score-ordered top-MAX_CAND list.
            var slot = n;
            if (n == MAX_CAND) {
                if (v <= ps[MAX_CAND - 1u]) { continue; }
                slot = MAX_CAND - 1u;
            } else {
                n = n + 1u;
            }
            while (slot > 0u && ps[slot - 1u] < v) {
                ps[slot] = ps[slot - 1u];
                pr[slot] = pr[slot - 1u];
                pc[slot] = pc[slot - 1u];
                slot = slot - 1u;
            }
            ps[slot] = v; pr[slot] = y; pc[slot] = x;
        }
    }

    // Refine each peak with the windowed soft-argmax centroid, dropping any that
    // lands on top of a higher-scoring one (two maxima on a single blob).
    var m = 0u;
    for (var i = 0u; i < n; i++) {
        var rx = f32(pc[i]);
        var ry = f32(pr[i]);
        if (params.win > 0) {
            let r0 = u32(max(0, i32(pr[i]) - params.win));
            let r1 = u32(min(i32(params.h), i32(pr[i]) + params.win + 1));
            let c0 = u32(max(0, i32(pc[i]) - params.win));
            let c1 = u32(min(i32(params.w), i32(pc[i]) + params.win + 1));
            var wsum = 0.0; var sy = 0.0; var sx = 0.0;
            for (var y = r0; y < r1; y++) {
                for (var x = c0; x < c1; x++) {
                    let v = hm_at(x, y, k);
                    wsum += v; sy += v * f32(y); sx += v * f32(x);
                }
            }
            wsum = max(wsum, 1e-6);
            rx = sx / wsum; ry = sy / wsum;
        }
        var dup = false;
        for (var j = 0u; j < m; j++) {
            let dx = c_x[k * MAX_CAND + j] - rx;
            let dy = c_y[k * MAX_CAND + j] - ry;
            if (sqrt(dx * dx + dy * dy) < MIN_SEP) { dup = true; }
        }
        if (dup) { continue; }
        c_x[k * MAX_CAND + m] = rx;
        c_y[k * MAX_CAND + m] = ry;
        c_s[k * MAX_CAND + m] = ps[i];
        m = m + 1u;
    }
    c_n[k] = m;

    workgroupBarrier();
    if (k != 0u) { return; }

    // \\u2500\\u2500 stage 2: eye-pair hypotheses \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    var h_score : array<f32, 25>;
    var h_kp    : array<i32, 125>;   // hypothesis q, channel t \\u2192 candidate idx (-1 = unmatched)
    var nh = 0u;
    let max_eye = f32(params.w) * 0.45;   // a face wider than ~half the frame

    for (var i = 0u; i < c_n[0]; i++) {
        for (var j = 0u; j < c_n[1]; j++) {
            let ax = c_x[i];
            let ay = c_y[i];
            let bx = c_x[MAX_CAND + j];
            let by = c_y[MAX_CAND + j];
            let evx = bx - ax;
            let evy = by - ay;
            let len = sqrt(evx * evx + evy * evy);
            if (len < MIN_EYE || len > max_eye) { continue; }
            let ex = vec2<f32>(evx / len, evy / len);
            let ey = vec2<f32>(-ex.y, ex.x);

            var sc      = c_s[i] + c_s[MAX_CAND + j];
            var resid   = 0.0;
            var n_match = 2u;
            var mouths  = 0u;
            var nose    = -1;
            var mo      = array<i32, 2>(-1, -1);

            for (var t = 0u; t < 3u; t++) {
                let kk = t + 2u;
                let px = ax + len * (tmpl_u(t) * ex.x + tmpl_w(t) * ey.x);
                let py = ay + len * (tmpl_u(t) * ex.y + tmpl_w(t) * ey.y);
                var best   = -1;
                var best_d = params.tol * len;
                for (var q = 0u; q < c_n[kk]; q++) {
                    let dx = c_x[kk * MAX_CAND + q] - px;
                    let dy = c_y[kk * MAX_CAND + q] - py;
                    let d  = sqrt(dx * dx + dy * dy);
                    if (d < best_d) { best_d = d; best = i32(q); }
                }
                if (best < 0) { continue; }
                sc += c_s[kk * MAX_CAND + u32(best)];
                resid += best_d / len;
                n_match += 1u;
                if (t == 0u) { nose = best; } else { mo[t - 1u] = best; mouths += 1u; }
            }
            // Support floor: a hypothesis needs the nose and at least one mouth
            // corner, otherwise two stray eye peaks become a face.
            if (nose < 0 || mouths < 1u) { continue; }

            h_score[nh] = sc / f32(n_match) - LAMBDA * (resid / f32(n_match - 2u));
            h_kp[nh * N_KP + 0u] = i32(i);
            h_kp[nh * N_KP + 1u] = i32(j);
            h_kp[nh * N_KP + 2u] = nose;
            h_kp[nh * N_KP + 3u] = mo[0];
            h_kp[nh * N_KP + 4u] = mo[1];
            nh = nh + 1u;
        }
    }

    // \\u2500\\u2500 stage 3/4: greedy NMS by score \\u2192 boxes \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    var used : array<bool, 25>;
    for (var i = 0u; i < N_KP * MAX_CAND; i++) { used[i] = false; }
    var out_n = 0u;

    for (var iter = 0u; iter < 25u; iter++) {
        if (out_n >= params.max_faces) { break; }

        // Best remaining hypothesis. Consumed ones are marked -1e9; real scores
        // are bounded well above -1e8 (mean peak \\u2208 [0,1] minus LAMBDA\\xB7tol).
        var best   = -1;
        var best_s = -1e8;
        for (var q = 0u; q < nh; q++) {
            if (h_score[q] > best_s) { best_s = h_score[q]; best = i32(q); }
        }
        if (best < 0) { break; }
        let q = u32(best);
        h_score[q] = -1e9;

        var clash = false;
        for (var t = 0u; t < N_KP; t++) {
            let ci = h_kp[q * N_KP + t];
            if (ci < 0) { continue; }
            if (used[t * MAX_CAND + u32(ci)]) { clash = true; }
        }
        if (clash) { continue; }

        // Hull over this face's matched keypoints, in grid cells.
        var x0 = 1e9; var x1 = -1e9;
        var y0 = 1e9; var y1 = -1e9;
        var score = 1e9;
        for (var t = 0u; t < N_KP; t++) {
            let ci = h_kp[q * N_KP + t];
            if (ci < 0) { continue; }
            let e = t * MAX_CAND + u32(ci);
            used[e] = true;
            x0 = min(x0, c_x[e]); x1 = max(x1, c_x[e]);
            y0 = min(y0, c_y[e]); y1 = max(y1, c_y[e]);
            score = min(score, c_s[e]);
        }

        let half_px = 0.5 * params.box_scale * max(x1 - x0, y1 - y0);
        let cx = ((x0 + x1) * 0.5 + 0.5) / f32(params.w);   // +0.5: cell \\u2192 center
        let cy = ((y0 + y1) * 0.5 + 0.5) / f32(params.h);
        out_buf[out_n] = vec4<f16>(vec4<f32>(cx, cy, half_px / f32(params.w), score));
        out_n = out_n + 1u;
    }

    for (var i = out_n; i < params.max_faces; i++) {
        out_buf[i] = vec4<f16>(0.0h, 0.0h, 0.0h, 0.0h);
    }
}
\`;var Ne=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch",[1,1,1]);i(this,"shader");if(t.c!==8)throw new Error(\`FaceBoxesFromHeatmaps: expected 8-ch heatmaps (5 real), got \${t.c}\`);if(a.maxFaces<1||a.maxFaces>6)throw new Error(\`FaceBoxesFromHeatmaps: maxFaces must be 1..6, got \${a.maxFaces}\`);this.shader=r.dtype==="f16"?Xr:Vr,this.output=r.tensor(1,a.maxFaces,4),this.inputs=[t],this.createUniform("params","Params");let o=new ArrayBuffer(32),n=new Uint32Array(o),s=new Int32Array(o),p=new Float32Array(o);n[0]=t.h,n[1]=t.w,s[2]=a.win,p[3]=a.thresh,p[4]=a.boxScale,n[5]=a.maxFaces,p[6]=a.tol,this.setUniform("params",n),this.defaultSetup()}};var jr=\`// Auto-reframe state update (f32) \\u2014 one thread, one frame of camera work.
// In:  boxes (1\\xD7K\\xD74, FaceBoxesFromHeatmaps), prev state, command.
// Out: new state, 1\\xD71\\xD78 = two vec4s:
//        [0] (cx, cy, size, moving)   \\u2014 the view rect; all FRAME FRACTIONS
//        [1] (subjX, subjY, subjHs, valid) \\u2014 the incumbent subject, for hysteresis
//
// The subject is remembered by POSITION, not by slot: FaceBoxesFromHeatmaps
// orders its slots by NMS score, so slot 1 can be a different person next frame.
//
// \\\`size\\\` is a fraction of BOTH width and height, which is what preserves the
// frame's aspect: equal fractions of a 640\\xD7400 frame is still 8:5.
//
// The rule (tuned in demo/reframe.ts):
//   centre = frameCentre + gravity\\xB7(subject \\u2212 frameCentre)   \\u2014 pull, never centre
//   crop   = frame / zoom
//   constraints: the crop stays INSIDE the frame AND contains the subject+margin
// Neither is a special case; "head in the corner does nothing" falls out of them:
// once the crop centre clamps to the frame edge, containment reduces to
// x >= half+margin regardless of zoom, so an edge subject simply never fits and
// the solve falls through to its full-frame fallback (= no reframe). The zoom
// relaxation earns its keep elsewhere \\u2014 backing off for a subject too BIG for
// the requested crop.
//
// Smoothing is deadband + ease: hold, move deliberately, hold. A plain EMA reads
// as swimming as the subject breathes.
//
// State is threaded across frames by the renderer with copyTensor \\u2014 same carrier
// pattern as the flow stabilizer's stabPrev. No readback anywhere.

struct Params {
    k        : u32,
    zoom     : f32,
    gravity  : f32,
    margin   : f32,
    deadband : f32,
    ease     : f32,
    aspect   : f32,   // frame w/h \\u2014 the box's halfSide is a fraction of WIDTH
    _pad     : f32,
}

// cmd.x \\u2014 0 auto (track), 1 manual-hold (frozen), 2 manual-solve (snap once).
const MODE_HOLD  : f32 = 1.0;
const MODE_SOLVE : f32 = 2.0;
// Subject hysteresis: a challenger must be this much bigger than the incumbent
// to take the camera, and the incumbent is re-found within this radius (or 2\\xD7
// its own halfSide, whichever is larger).
const SWITCH_RATIO     : f32 = 1.25;
const TRACK_RADIUS_MIN : f32 = 0.1;

@group(0) @binding(0) var<storage, read>       box_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       prev_buf : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       cmd_buf  : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>             params   : Params;
@group(0) @binding(4) var<storage, read_write> out_buf  : array<vec4<f32>>;

@compute @workgroup_size(1, 1, 1)
fn main() {
    let prev   = prev_buf[0];
    let prev_s = prev_buf[1];
    let mode   = cmd_buf[0].x;

    // \\u2500\\u2500 subject selection, with hysteresis \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    // Challenger = the largest live face.
    var chal = -1;
    var chal_hs = 0.0;
    for (var i = 0u; i < params.k; i++) {
        let b = box_buf[i];
        if (b.w > 0.0 && b.z > chal_hs) { chal_hs = b.z; chal = i32(i); }
    }
    if (chal < 0) {
        out_buf[0] = prev;
        out_buf[1] = prev_s;   // keep the memory: a one-frame detection miss must
        return;                // not hand the camera to someone else
    }

    // Incumbent = the live face nearest where the subject was, tracked by
    // position because slot indices aren't stable identities.
    var inc = -1;
    var inc_d = 1e9;
    if (prev_s.w > 0.5) {
        let radius = max(TRACK_RADIUS_MIN, prev_s.z * 2.0);
        for (var i = 0u; i < params.k; i++) {
            let b = box_buf[i];
            if (b.w <= 0.0) { continue; }
            let d = length(vec2<f32>(b.x - prev_s.x, b.y - prev_s.y));
            if (d < radius && d < inc_d) { inc_d = d; inc = i32(i); }
        }
    }

    // Stick with the incumbent unless the challenger is decisively bigger.
    // halfSide \\u2248 1/distance, so 1.25\\xD7 \\u2248 "20% closer to the camera" \\u2014 enough that
    // two people sitting side by side can't trade the camera back and forth.
    var pick = chal;
    if (inc >= 0 && chal_hs <= box_buf[u32(inc)].z * SWITCH_RATIO) { pick = inc; }
    let subj = box_buf[u32(pick)];
    out_buf[1] = vec4<f32>(subj.x, subj.y, subj.z, 1.0);

    // Solve. Stepped relaxation rather than closed-form: the frame-edge clamp
    // makes the centre depend on the crop size, so it's implicit.
    let half_x = subj.z;
    let half_y = subj.z * params.aspect;
    // Fallback = the FULL frame, i.e. no reframe at all. A subject too close to
    // the edge to contain can't be rescued by relaxing zoom (once the crop centre
    // clamps to the frame edge, the containment test reduces to x >= half+margin,
    // independent of zoom) \\u2014 so it falls through to this and eases out to the raw
    // frame. That IS "head in the corner does nothing"; holding the last crop
    // instead would freeze on a shot the subject is walking out of.
    //
    // What the relaxation actually buys is the other axis: a subject too BIG for
    // the requested zoom (a close-up) backs the crop off until they fit.
    var w_cx = 0.5; var w_cy = 0.5; var w_s = 1.0;
    for (var t = 0; t <= 25; t++) {
        let z = params.zoom + (1.0 - params.zoom) * (f32(t) / 25.0);
        let s = 1.0 / z;
        let cx = clamp(0.5 + params.gravity * (subj.x - 0.5), s * 0.5, 1.0 - s * 0.5);
        let cy = clamp(0.5 + params.gravity * (subj.y - 0.5), s * 0.5, 1.0 - s * 0.5);
        if (abs(subj.x - cx) + half_x + params.margin <= s * 0.5 &&
            abs(subj.y - cy) + half_y + params.margin <= s * 0.5) {
            w_cx = cx; w_cy = cy; w_s = s;
            break;
        }
    }
    // size 0 = uninitialised: snap rather than easing in from nothing. This is
    // also what makes manual mode "reframe once when enabled, then freeze".
    if (prev.z <= 0.0 || mode == MODE_SOLVE) {
        out_buf[0] = vec4<f32>(w_cx, w_cy, w_s, 0.0);
        return;
    }
    if (mode == MODE_HOLD) { out_buf[0] = prev; return; }

    let d = length(vec2<f32>(w_cx - prev.x, w_cy - prev.y)) + abs(w_s - prev.z);
    var moving = prev.w;
    if (d > params.deadband) { moving = 1.0; }
    else if (d < params.deadband * 0.3) { moving = 0.0; }
    if (moving < 0.5) { out_buf[0] = vec4<f32>(prev.xyz, 0.0); return; }

    out_buf[0] = vec4<f32>(
        mix(prev.x, w_cx, params.ease),
        mix(prev.y, w_cy, params.ease),
        mix(prev.z, w_s,  params.ease),
        1.0,
    );
}
\`;var qr=\`enable f16;

// Auto-reframe state update (f16 storage, f32 math) \\u2014 one thread, one frame of camera work.
// NOTE f16: the ease step is ~0.07\\xB7d and only runs while d > deadband(0.09), so
// steps are ~1.9e-3 \\u2014 comfortably above f16's ~4.9e-4 resolution near 0.5. It
// converges to the deadband then holds exactly (prev is passed through, not
// re-lerped), so there's no slow drift.
// In:  boxes (1\\xD7K\\xD74, FaceBoxesFromHeatmaps), prev state, command.
// Out: new state, 1\\xD71\\xD78 = two vec4s:
//        [0] (cx, cy, size, moving)   \\u2014 the view rect; all FRAME FRACTIONS
//        [1] (subjX, subjY, subjHs, valid) \\u2014 the incumbent subject, for hysteresis
//
// The subject is remembered by POSITION, not by slot: FaceBoxesFromHeatmaps
// orders its slots by NMS score, so slot 1 can be a different person next frame.
//
// \\\`size\\\` is a fraction of BOTH width and height, which is what preserves the
// frame's aspect: equal fractions of a 640\\xD7400 frame is still 8:5.
//
// The rule (tuned in demo/reframe.ts):
//   centre = frameCentre + gravity\\xB7(subject \\u2212 frameCentre)   \\u2014 pull, never centre
//   crop   = frame / zoom
//   constraints: the crop stays INSIDE the frame AND contains the subject+margin
// Neither is a special case; "head in the corner does nothing" falls out of them:
// once the crop centre clamps to the frame edge, containment reduces to
// x >= half+margin regardless of zoom, so an edge subject simply never fits and
// the solve falls through to its full-frame fallback (= no reframe). The zoom
// relaxation earns its keep elsewhere \\u2014 backing off for a subject too BIG for
// the requested crop.
//
// Smoothing is deadband + ease: hold, move deliberately, hold. A plain EMA reads
// as swimming as the subject breathes.
//
// State is threaded across frames by the renderer with copyTensor \\u2014 same carrier
// pattern as the flow stabilizer's stabPrev. No readback anywhere.

struct Params {
    k        : u32,
    zoom     : f32,
    gravity  : f32,
    margin   : f32,
    deadband : f32,
    ease     : f32,
    aspect   : f32,   // frame w/h \\u2014 the box's halfSide is a fraction of WIDTH
    _pad     : f32,
}

// cmd.x \\u2014 0 auto (track), 1 manual-hold (frozen), 2 manual-solve (snap once).
const MODE_HOLD  : f32 = 1.0;
const MODE_SOLVE : f32 = 2.0;
// Subject hysteresis: a challenger must be this much bigger than the incumbent
// to take the camera, and the incumbent is re-found within this radius (or 2\\xD7
// its own halfSide, whichever is larger).
const SWITCH_RATIO     : f32 = 1.25;
const TRACK_RADIUS_MIN : f32 = 0.1;

@group(0) @binding(0) var<storage, read>       box_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       prev_buf : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       cmd_buf  : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>             params   : Params;
@group(0) @binding(4) var<storage, read_write> out_buf  : array<vec4<f16>>;

@compute @workgroup_size(1, 1, 1)
fn main() {
    let prev   = vec4<f32>(prev_buf[0]);
    let prev_s = vec4<f32>(prev_buf[1]);
    let mode   = f32(cmd_buf[0].x);

    // \\u2500\\u2500 subject selection, with hysteresis \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    // Challenger = the largest live face.
    var chal = -1;
    var chal_hs = 0.0;
    for (var i = 0u; i < params.k; i++) {
        let b = vec4<f32>(box_buf[i]);
        if (b.w > 0.0 && b.z > chal_hs) { chal_hs = b.z; chal = i32(i); }
    }
    if (chal < 0) {
        out_buf[0] = vec4<f16>(prev);
        out_buf[1] = vec4<f16>(prev_s);   // keep the memory: a one-frame detection miss must
        return;                // not hand the camera to someone else
    }

    // Incumbent = the live face nearest where the subject was, tracked by
    // position because slot indices aren't stable identities.
    var inc = -1;
    var inc_d = 1e9;
    if (prev_s.w > 0.5) {
        let radius = max(TRACK_RADIUS_MIN, prev_s.z * 2.0);
        for (var i = 0u; i < params.k; i++) {
            let b = vec4<f32>(box_buf[i]);
            if (b.w <= 0.0) { continue; }
            let d = length(vec2<f32>(b.x - prev_s.x, b.y - prev_s.y));
            if (d < radius && d < inc_d) { inc_d = d; inc = i32(i); }
        }
    }

    // Stick with the incumbent unless the challenger is decisively bigger.
    // halfSide \\u2248 1/distance, so 1.25\\xD7 \\u2248 "20% closer to the camera" \\u2014 enough that
    // two people sitting side by side can't trade the camera back and forth.
    var pick = chal;
    if (inc >= 0 && chal_hs <= f32(box_buf[u32(inc)].z) * SWITCH_RATIO) { pick = inc; }
    let subj = vec4<f32>(box_buf[u32(pick)]);
    out_buf[1] = vec4<f16>(vec4<f32>(subj.x, subj.y, subj.z, 1.0));

    // Solve. Stepped relaxation rather than closed-form: the frame-edge clamp
    // makes the centre depend on the crop size, so it's implicit.
    let half_x = subj.z;
    let half_y = subj.z * params.aspect;
    // Fallback = the FULL frame, i.e. no reframe at all. A subject too close to
    // the edge to contain can't be rescued by relaxing zoom (once the crop centre
    // clamps to the frame edge, the containment test reduces to x >= half+margin,
    // independent of zoom) \\u2014 so it falls through to this and eases out to the raw
    // frame. That IS "head in the corner does nothing"; holding the last crop
    // instead would freeze on a shot the subject is walking out of.
    //
    // What the relaxation actually buys is the other axis: a subject too BIG for
    // the requested zoom (a close-up) backs the crop off until they fit.
    var w_cx = 0.5; var w_cy = 0.5; var w_s = 1.0;
    for (var t = 0; t <= 25; t++) {
        let z = params.zoom + (1.0 - params.zoom) * (f32(t) / 25.0);
        let s = 1.0 / z;
        let cx = clamp(0.5 + params.gravity * (subj.x - 0.5), s * 0.5, 1.0 - s * 0.5);
        let cy = clamp(0.5 + params.gravity * (subj.y - 0.5), s * 0.5, 1.0 - s * 0.5);
        if (abs(subj.x - cx) + half_x + params.margin <= s * 0.5 &&
            abs(subj.y - cy) + half_y + params.margin <= s * 0.5) {
            w_cx = cx; w_cy = cy; w_s = s;
            break;
        }
    }
    // size 0 = uninitialised: snap rather than easing in from nothing. This is
    // also what makes manual mode "reframe once when enabled, then freeze".
    if (prev.z <= 0.0 || mode == MODE_SOLVE) {
        out_buf[0] = vec4<f16>(vec4<f32>(w_cx, w_cy, w_s, 0.0));
        return;
    }
    if (mode == MODE_HOLD) { out_buf[0] = vec4<f16>(prev); return; }

    let d = length(vec2<f32>(w_cx - prev.x, w_cy - prev.y)) + abs(w_s - prev.z);
    var moving = prev.w;
    if (d > params.deadband) { moving = 1.0; }
    else if (d < params.deadband * 0.3) { moving = 0.0; }
    if (moving < 0.5) { out_buf[0] = vec4<f16>(vec4<f32>(prev.xyz, 0.0)); return; }

    out_buf[0] = vec4<f16>(vec4<f32>(
        mix(prev.x, w_cx, params.ease),
        mix(prev.y, w_cy, params.ease),
        mix(prev.z, w_s,  params.ease),
        1.0,
    ));
}
\`;var Ve=class extends h{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch",[1,1,1]);i(this,"shader");this.shader=r.dtype==="f16"?qr:jr,this.output=r.tensor(1,1,8),this.inputs=[t,a,o],this.createUniform("params","Params");let s=new ArrayBuffer(32);new Uint32Array(s,0,1)[0]=t.w*t.h;let p=new Float32Array(s,4,7);p[0]=n.zoom,p[1]=n.gravity,p[2]=n.margin,p[3]=n.deadband,p[4]=n.ease,p[5]=n.aspect,this.setUniform("params",new Uint32Array(s)),this.defaultSetup()}};var $r=\`// Apply the reframe crop (f32): sample \\\`src\\\` through the view rect. Same shape
// in and out \\u2014 this is the geometric slot of the one-compositor design.
//
// Applied AFTER the effect chain (touch-up draws its mesh at FULL-frame landmark
// coords; reframing upstream would land every face effect in the wrong place),
// and to the foreground + alpha only. The background is bound separately by the
// compositor and deliberately does NOT move \\u2014 you zoom toward the person, the
// virtual backdrop behind them stays put. Blur backgrounds are derived from the
// foreground, so they follow for free; no per-mode special case.
//
// rect = (cx, cy, size, moving) in frame fractions; size is a fraction of BOTH
// dims (that's what preserves aspect). size \\u2264 0 means uninitialised \\u2192 identity.

struct Params {
    h : u32,
    w : u32,
}

@group(0) @binding(0) var<storage, read>       src_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       rect_buf : array<vec4<f32>>;
@group(0) @binding(2) var<uniform>             params   : Params;
@group(0) @binding(3) var<storage, read_write> out_buf  : array<vec4<f32>>;

fn samp(x: i32, y: i32) -> vec4<f32> {
    let cx = clamp(x, 0, i32(params.w) - 1);
    let cy = clamp(y, 0, i32(params.h) - 1);
    return src_buf[u32(cy) * params.w + u32(cx)];
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.w || gid.y >= params.h) { return; }

    let r = rect_buf[0];
    var s = r.z; var rcx = r.x; var rcy = r.y;
    if (s <= 0.0) { s = 1.0; rcx = 0.5; rcy = 0.5; }   // identity until the first solve

    let fx = (rcx - s * 0.5) + ((f32(gid.x) + 0.5) / f32(params.w)) * s;
    let fy = (rcy - s * 0.5) + ((f32(gid.y) + 0.5) / f32(params.h)) * s;
    // frame fraction \\u2192 texel index (a texel's centre sits at index + 0.5), so an
    // identity rect samples each texel exactly and the op is a bit-exact copy.
    let sx = fx * f32(params.w) - 0.5;
    let sy = fy * f32(params.h) - 0.5;

    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);

    let top = mix(samp(x0, y0),     samp(x0 + 1, y0),     tx);
    let bot = mix(samp(x0, y0 + 1), samp(x0 + 1, y0 + 1), tx);
    out_buf[gid.y * params.w + gid.x] = mix(top, bot, ty);
}
\`;var Kr=\`enable f16;

// Apply the reframe crop (f16 storage, f32 math): sample \\\`src\\\` through the view rect. Same shape
// in and out \\u2014 this is the geometric slot of the one-compositor design.
//
// Applied AFTER the effect chain (touch-up draws its mesh at FULL-frame landmark
// coords; reframing upstream would land every face effect in the wrong place),
// and to the foreground + alpha only. The background is bound separately by the
// compositor and deliberately does NOT move \\u2014 you zoom toward the person, the
// virtual backdrop behind them stays put. Blur backgrounds are derived from the
// foreground, so they follow for free; no per-mode special case.
//
// rect = (cx, cy, size, moving) in frame fractions; size is a fraction of BOTH
// dims (that's what preserves aspect). size \\u2264 0 means uninitialised \\u2192 identity.

struct Params {
    h : u32,
    w : u32,
}

@group(0) @binding(0) var<storage, read>       src_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       rect_buf : array<vec4<f16>>;
@group(0) @binding(2) var<uniform>             params   : Params;
@group(0) @binding(3) var<storage, read_write> out_buf  : array<vec4<f16>>;

fn samp(x: i32, y: i32) -> vec4<f32> {
    let cx = clamp(x, 0, i32(params.w) - 1);
    let cy = clamp(y, 0, i32(params.h) - 1);
    return vec4<f32>(src_buf[u32(cy) * params.w + u32(cx)]);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= params.w || gid.y >= params.h) { return; }

    let r = vec4<f32>(rect_buf[0]);
    var s = r.z; var rcx = r.x; var rcy = r.y;
    if (s <= 0.0) { s = 1.0; rcx = 0.5; rcy = 0.5; }   // identity until the first solve

    let fx = (rcx - s * 0.5) + ((f32(gid.x) + 0.5) / f32(params.w)) * s;
    let fy = (rcy - s * 0.5) + ((f32(gid.y) + 0.5) / f32(params.h)) * s;
    // frame fraction \\u2192 texel index (a texel's centre sits at index + 0.5), so an
    // identity rect samples each texel exactly and the op is a bit-exact copy.
    let sx = fx * f32(params.w) - 0.5;
    let sy = fy * f32(params.h) - 0.5;

    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);

    let top = mix(samp(x0, y0),     samp(x0 + 1, y0),     tx);
    let bot = mix(samp(x0, y0 + 1), samp(x0 + 1, y0 + 1), tx);
    out_buf[gid.y * params.w + gid.x] = vec4<f16>(mix(top, bot, ty));
}
\`;var Xe=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Kr:$r,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var Yr=\`// Box-driven square crop + bilinear resample + channel normalization (f32).
// Reads the box tensor (FaceBoxFromHeatmaps output: cx, cy, halfSide, score in
// frame fractions; halfSide as a fraction of frame WIDTH) and emits the
// landmark model's input: ((rgb - mean) / std), .w = 0.
//
// Sampling mirrors landmark training's warpAffine: src = center + (u - out/2)
// \\xB7 side/out \\u2014 u is the integer output pixel index (cv2 convention).

struct Params {
    in_h  : u32,
    in_w  : u32,
    out_h : u32,
    out_w : u32,
    slot  : u32,        // box-tensor slot (multi-face); 0 for the single-face path
    pad0  : u32,
    pad1  : u32,
    pad2  : u32,
    mean  : vec4<f32>,   // .xyz used
    stdev : vec4<f32>,   // .xyz used
}

@group(0) @binding(0) var<storage, read>       frame_buf : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       box_buf   : array<vec4<f32>>;
@group(0) @binding(2) var<uniform>             params    : Params;
@group(0) @binding(3) var<storage, read_write> out_buf   : array<vec4<f32>>;

fn samp(x: i32, y: i32, W: i32, H: i32) -> vec4<f32> {
    let cx = clamp(x, 0, W - 1);
    let cy = clamp(y, 0, H - 1);
    return frame_buf[u32(cy) * u32(W) + u32(cx)];
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.out_w || y >= params.out_h) { return; }

    let W = i32(params.in_w);
    let H = i32(params.in_h);
    let box = box_buf[params.slot];
    let cx   = box.x * f32(params.in_w);
    let cy   = box.y * f32(params.in_h);
    let side = 2.0 * box.z * f32(params.in_w);   // square in frame px

    let sx = clamp(cx + (f32(x) - f32(params.out_w) * 0.5) * side / f32(params.out_w), 0.0, f32(W - 1));
    let sy = clamp(cy + (f32(y) - f32(params.out_h) * 0.5) * side / f32(params.out_h), 0.0, f32(H - 1));

    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);

    let top = mix(samp(x0, y0, W, H), samp(x0 + 1, y0, W, H), tx);
    let bot = mix(samp(x0, y0 + 1, W, H), samp(x0 + 1, y0 + 1, W, H), tx);
    let v = mix(top, bot, ty);

    let n = (v.rgb - params.mean.rgb) / params.stdev.rgb;
    out_buf[y * params.out_w + x] = vec4<f32>(n, 0.0);
}
\`;var Qr=\`enable f16;

// Box-driven square crop + bilinear resample + channel normalization (f16 storage, f32 math).
// Reads the box tensor (FaceBoxFromHeatmaps output: cx, cy, halfSide, score in
// frame fractions; halfSide as a fraction of frame WIDTH) and emits the
// landmark model's input: ((rgb - mean) / std), .w = 0.
//
// Sampling mirrors landmark training's warpAffine: src = center + (u - out/2)
// \\xB7 side/out \\u2014 u is the integer output pixel index (cv2 convention).

struct Params {
    in_h  : u32,
    in_w  : u32,
    out_h : u32,
    out_w : u32,
    slot  : u32,        // box-tensor slot (multi-face); 0 for the single-face path
    pad0  : u32,
    pad1  : u32,
    pad2  : u32,
    mean  : vec4<f32>,   // .xyz used
    stdev : vec4<f32>,   // .xyz used
}

@group(0) @binding(0) var<storage, read>       frame_buf : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       box_buf   : array<vec4<f16>>;
@group(0) @binding(2) var<uniform>             params    : Params;
@group(0) @binding(3) var<storage, read_write> out_buf   : array<vec4<f16>>;

fn samp(x: i32, y: i32, W: i32, H: i32) -> vec4<f32> {
    let cx = clamp(x, 0, W - 1);
    let cy = clamp(y, 0, H - 1);
    return vec4<f32>(frame_buf[u32(cy) * u32(W) + u32(cx)]);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.out_w || y >= params.out_h) { return; }

    let W = i32(params.in_w);
    let H = i32(params.in_h);
    let box = vec4<f32>(box_buf[params.slot]);
    let cx   = box.x * f32(params.in_w);
    let cy   = box.y * f32(params.in_h);
    let side = 2.0 * box.z * f32(params.in_w);   // square in frame px

    let sx = clamp(cx + (f32(x) - f32(params.out_w) * 0.5) * side / f32(params.out_w), 0.0, f32(W - 1));
    let sy = clamp(cy + (f32(y) - f32(params.out_h) * 0.5) * side / f32(params.out_h), 0.0, f32(H - 1));

    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);

    let top = mix(samp(x0, y0, W, H), samp(x0 + 1, y0, W, H), tx);
    let bot = mix(samp(x0, y0 + 1, W, H), samp(x0 + 1, y0 + 1, W, H), tx);
    let v = mix(top, bot, ty);

    let n = (v.rgb - params.mean.rgb) / params.stdev.rgb;
    out_buf[y * params.out_w + x] = vec4<f16>(vec4<f32>(n, 0.0));
}
\`;var je=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Qr:Yr,this.output=r.tensor(o.outH,o.outW,4),this.inputs=[t,a];let n=o.slot??0;if(n>=a.w*a.h)throw new Error(\`CropResample: slot \${n} out of range for a \${a.h}\\xD7\${a.w} box tensor\`);this.createUniform("params","Params");let s=new ArrayBuffer(64),p=new Uint32Array(s,0,5);p[0]=t.h,p[1]=t.w,p[2]=o.outH,p[3]=o.outW,p[4]=n,new Float32Array(s,32,4).set([...o.mean,0]),new Float32Array(s,48,4).set([...o.std,1]),this.setUniform("params",new Uint32Array(s)),this.defaultSetup(),this.dispatch=[Math.ceil(o.outW/8),Math.ceil(o.outH/8),1]}};var Jr=\`// Landmark overlay (f32) \\u2014 draws the image, then VERTEX-PULLS landmark dots
// straight from the LandmarkNet output tensor: the vertex shader fetches
// landmark i from the storage buffer and transforms crop coords \\u2192 canvas NDC
// via the box tensor. The per-frame landmark data never touches the CPU.
//
// Entry points: vs_img/fs_img (fullscreen image, 6 verts) and vs_pts/fs_pts
// (count \\xD7 6 verts \\u2014 one quad per landmark; WebGPU has no point size).

struct Params {
    img_w      : u32,
    count      : u32,
    thresh     : f32,   // hide all dots when box score < thresh
    point_size : f32,   // dot diameter in canvas px
    slot       : u32,   // box-tensor slot to read (multi-face); 0 = single-face
    color      : vec4<f32>,
    canvas     : vec4<f32>,   // .xy = canvas w, h
}

@group(0) @binding(0) var<storage, read> image_buf : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> lm_buf    : array<vec4<f32>>;   // 478 \\xD7 (x, y), [0,1] crop coords
@group(0) @binding(2) var<storage, read> box_buf   : array<vec4<f32>>;   // (cx, cy, halfSide/W, score) frame fractions
@group(0) @binding(3) var<uniform>       params    : Params;

// \\u2500\\u2500 image pass \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

struct VOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_img(@builtin(vertex_index) vi: u32) -> VOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

@fragment
fn fs_img(in: VOut) -> @location(0) vec4<f32> {
    let i = u32(in.pos.y) * params.img_w + u32(in.pos.x);
    return vec4<f32>(image_buf[i].rgb, 1.0);
}

// \\u2500\\u2500 landmark dots \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

@vertex
fn vs_pts(@builtin(vertex_index) vi: u32) -> VOut {
    let i      = vi / 6u;
    let corner = vi % 6u;
    var out: VOut;

    let box = box_buf[params.slot];
    if (box.w < params.thresh || i >= params.count) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);   // clipped away
        return out;
    }

    // Landmark i: two (x, y) pairs per vec4.
    var g = lm_buf[i / 2u];
    let lx = g[(i % 2u) * 2u];
    let ly = g[(i % 2u) * 2u + 1u];

    // Crop coords [0,1] \\u2192 frame fractions. halfSide is a fraction of WIDTH;
    // the y half-extent rescales by the canvas aspect (the box is px-square).
    let hsx = box.z;
    let hsy = box.z * params.canvas.x / params.canvas.y;
    let px = (box.x - hsx) + lx * 2.0 * hsx;
    let py = (box.y - hsy) + ly * 2.0 * hsy;

    let corners = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    let off = corners[corner] * params.point_size / params.canvas.xy;   // NDC half-extents \\xD72
    out.pos = vec4<f32>(px * 2.0 - 1.0 + off.x, 1.0 - 2.0 * py + off.y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_pts(in: VOut) -> @location(0) vec4<f32> {
    return vec4<f32>(params.color.rgb, 1.0);
}
\`;var Zr=\`enable f16;

// Landmark overlay (f16 storage, f32 math) \\u2014 draws the image, then VERTEX-PULLS landmark dots
// straight from the LandmarkNet output tensor: the vertex shader fetches
// landmark i from the storage buffer and transforms crop coords \\u2192 canvas NDC
// via the box tensor. The per-frame landmark data never touches the CPU.
//
// Entry points: vs_img/fs_img (fullscreen image, 6 verts) and vs_pts/fs_pts
// (count \\xD7 6 verts \\u2014 one quad per landmark; WebGPU has no point size).

struct Params {
    img_w      : u32,
    count      : u32,
    thresh     : f32,   // hide all dots when box score < thresh
    point_size : f32,   // dot diameter in canvas px
    slot       : u32,   // box-tensor slot to read (multi-face); 0 = single-face
    color      : vec4<f32>,
    canvas     : vec4<f32>,   // .xy = canvas w, h
}

@group(0) @binding(0) var<storage, read> image_buf : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read> lm_buf    : array<vec4<f16>>;   // 478 \\xD7 (x, y), [0,1] crop coords
@group(0) @binding(2) var<storage, read> box_buf   : array<vec4<f16>>;   // (cx, cy, halfSide/W, score) frame fractions
@group(0) @binding(3) var<uniform>       params    : Params;

// \\u2500\\u2500 image pass \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

struct VOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs_img(@builtin(vertex_index) vi: u32) -> VOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

@fragment
fn fs_img(in: VOut) -> @location(0) vec4<f32> {
    let i = u32(in.pos.y) * params.img_w + u32(in.pos.x);
    return vec4<f32>(vec3<f32>(image_buf[i].rgb), 1.0);
}

// \\u2500\\u2500 landmark dots \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

@vertex
fn vs_pts(@builtin(vertex_index) vi: u32) -> VOut {
    let i      = vi / 6u;
    let corner = vi % 6u;
    var out: VOut;

    let box = vec4<f32>(box_buf[params.slot]);
    if (box.w < params.thresh || i >= params.count) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);   // clipped away
        return out;
    }

    // Landmark i: two (x, y) pairs per vec4.
    var g = vec4<f32>(lm_buf[i / 2u]);
    let lx = g[(i % 2u) * 2u];
    let ly = g[(i % 2u) * 2u + 1u];

    // Crop coords [0,1] \\u2192 frame fractions. halfSide is a fraction of WIDTH;
    // the y half-extent rescales by the canvas aspect (the box is px-square).
    let hsx = box.z;
    let hsy = box.z * params.canvas.x / params.canvas.y;
    let px = (box.x - hsx) + lx * 2.0 * hsx;
    let py = (box.y - hsy) + ly * 2.0 * hsy;

    let corners = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    let off = corners[corner] * params.point_size / params.canvas.xy;   // NDC half-extents \\xD72
    out.pos = vec4<f32>(px * 2.0 - 1.0 + off.x, 1.0 - 2.0 * py + off.y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_pts(in: VOut) -> @location(0) vec4<f32> {
    return vec4<f32>(params.color.rgb, 1.0);
}
\`;var qe=class{constructor(e,r,t,a,o){i(this,"backend",e);i(this,"imgPipeline");i(this,"ptsPipeline");i(this,"imgBindGroup");i(this,"ptsBindGroup");i(this,"count");i(this,"drawImage");i(this,"outputView",null);if(t.c<o.count*2)throw new Error(\`LandmarkOverlay: landmarks tensor holds \${t.c/2} points < count \${o.count}\`);let n=o.slot??0;if(n>=a.w*a.h)throw new Error(\`LandmarkOverlay: slot \${n} out of range for a \${a.h}\\xD7\${a.w} box tensor\`);this.count=o.count,this.drawImage=o.drawImage??!0;let s=e.device,p=s.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),c=new ArrayBuffer(64),l=new Uint32Array(c,0,2);l[0]=r.w,l[1]=o.count;let f=new Float32Array(c,8,2);f[0]=o.thresh,f[1]=o.pointSize,new Uint32Array(c,16,1)[0]=n,new Float32Array(c,32,4).set([...o.color,1]),new Float32Array(c,48,4).set([r.w,r.h,0,0]),s.queue.writeBuffer(p,0,c);let d=s.createShaderModule({code:e.dtype==="f16"?Zr:Jr}),_=[{format:e.canvasFormat}];this.imgPipeline=s.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs_img"},fragment:{module:d,entryPoint:"fs_img",targets:_},primitive:{topology:"triangle-list"}}),this.ptsPipeline=s.createRenderPipeline({layout:"auto",vertex:{module:d,entryPoint:"vs_pts"},fragment:{module:d,entryPoint:"fs_pts",targets:_},primitive:{topology:"triangle-list"}}),this.imgBindGroup=s.createBindGroup({layout:this.imgPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.buffer}},{binding:3,resource:{buffer:p}}]}),this.ptsBindGroup=s.createBindGroup({layout:this.ptsPipeline.getBindGroupLayout(0),entries:[{binding:1,resource:{buffer:t.buffer}},{binding:2,resource:{buffer:a.buffer}},{binding:3,resource:{buffer:p}}]})}setOutput(e){this.outputView=e.createView()}run(){if(!this.outputView)throw new Error("LandmarkOverlayWebGPU.run() called before setOutput()");let e=this.backend.device.createCommandEncoder(),r=e.beginRenderPass({colorAttachments:[{view:this.outputView,clearValue:[0,0,0,1],loadOp:this.drawImage?"clear":"load",storeOp:"store"}]});this.drawImage&&(r.setPipeline(this.imgPipeline),r.setBindGroup(0,this.imgBindGroup),r.draw(6)),r.setPipeline(this.ptsPipeline),r.setBindGroup(0,this.ptsBindGroup),r.draw(this.count*6),r.end(),this.backend.device.queue.submit([e.finish()]),this.outputView=null}};var fr=\`// UV-space face touch-up (f32) \\u2014 five passes, one module:
//   unwrap    : canonical mesh \\u2192 512\\xB2 atlas; vertex at canonical UV, textured
//               by the frame at its landmark's position (vertex-pulled from the
//               landmark tensor, crop \\u2192 frame via the box tensor). The
//               rasterizer's barycentric interpolation IS the piecewise-affine
//               warp \\u2014 one draw call.
//   blur \\xD72   : separable gaussian on the atlas (freq-sep low band). Uses the
//               framebuffer-aligned vquad_fb so read row == write row and no
//               vertical flip accumulates across passes (WebGPU NDC-y is up,
//               texel rows are down).
//   combine   : low + (atlas \\u2212 low) \\xB7 detail \\u2014 smooths skin, keeps pores.
//   composite : frame passthrough, then the mesh drawn at landmark screen
//               positions sampling the smoothed atlas, blended by the static
//               weight mask \\xD7 strength. Score-gated: no face \\u2192 passthrough.
//
// Landmarks are [0,1] CROP coords; the box tensor (cx, cy, halfSide/W, score,
// frame fractions) turns them into frame fractions in the vertex shaders \\u2014
// the whole path stays GPU-resident.

struct Uni {
    frame_w  : u32,
    frame_h  : u32,
    sigma    : f32,
    detail   : f32,
    strength : f32,
    thresh   : f32,
    dir      : vec2<f32>,   // blur step (1/atlas, 0) or (0, 1/atlas)
    canvas   : vec2<f32>,   // frame w, h (aspect for the box y half-extent)
    slots    : u32,         // faces packed into lm_buf / box_buf (1 or 4)
    grid     : u32,         // atlas tile grid: 1 \\u2192 whole atlas, 2 \\u2192 2\\xD72 tiles
}

@group(0) @binding(0) var<storage, read> frame_buf : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> lm_buf    : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> box_buf   : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>       uni       : Uni;
@group(0) @binding(4) var samp : sampler;
@group(0) @binding(5) var tex0 : texture_2d<f32>;
@group(0) @binding(6) var tex1 : texture_2d<f32>;

// Bilinear sample of the frame tensor buffer at frame-fraction coords.
fn frame_at(px: i32, py: i32) -> vec3<f32> {
    let x = clamp(px, 0, i32(uni.frame_w) - 1);
    let y = clamp(py, 0, i32(uni.frame_h) - 1);
    return frame_buf[u32(y) * uni.frame_w + u32(x)].rgb;
}
fn frame_bilinear(f: vec2<f32>) -> vec3<f32> {
    let sx = clamp(f.x * f32(uni.frame_w) - 0.5, 0.0, f32(uni.frame_w - 1u));
    let sy = clamp(f.y * f32(uni.frame_h) - 0.5, 0.0, f32(uni.frame_h - 1u));
    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);
    let top = mix(frame_at(x0, y0),     frame_at(x0 + 1, y0),     tx);
    let bot = mix(frame_at(x0, y0 + 1), frame_at(x0 + 1, y0 + 1), tx);
    return mix(top, bot, ty);
}

// Landmark i \\u2192 (frame-fraction x, y, score). halfSide is a fraction of frame
// WIDTH; the y half-extent rescales by the aspect (the box is px-square).
fn lm_frame(i: u32, face: u32) -> vec3<f32> {
    let box = box_buf[face];
    // lm_buf packs \\\`slots\\\` faces \\xD7 478 landmarks (ChannelConcat of the K
    // LandmarkNet outputs); 478 is even, so face f starts on a vec4 boundary.
    let gi = face * 478u + i;
    var g = lm_buf[gi / 2u];
    let lx = g[(gi % 2u) * 2u];
    let ly = g[(gi % 2u) * 2u + 1u];
    let hsx = box.z;
    let hsy = box.z * uni.canvas.x / uni.canvas.y;
    return vec3<f32>((box.x - hsx) + lx * 2.0 * hsx, (box.y - hsy) + ly * 2.0 * hsy, box.w);
}

// Face \\\`face\\\` owns tile (face % grid, face / grid) of the atlas. grid=1 (K=1)
// maps to the whole atlas \\u2014 i.e. the single-face layout, unchanged.
fn tile_uv(uv: vec2<f32>, face: u32) -> vec2<f32> {
    let g = f32(uni.grid);
    return (uv + vec2<f32>(f32(face % uni.grid), f32(face / uni.grid))) / g;
}

// The tile containing \\\`uv\\\`, as (lo.x, lo.y, hi.x, hi.y) \\u2014 filter passes clamp
// their taps to it so one face's skin can't bleed into a neighbour's tile.
fn tile_bounds(uv: vec2<f32>) -> vec4<f32> {
    let g = f32(uni.grid);
    let t = floor(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999)) * g);
    return vec4<f32>(t / g, (t + vec2<f32>(1.0, 1.0)) / g);
}

// \\u2500\\u2500 unwrap: mesh \\u2192 atlas \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

struct UnwrapOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) src: vec2<f32>,   // frame-fraction sample position
};

@vertex
fn vs_unwrap(@builtin(instance_index) inst: u32,
             @location(0) a_uv: vec2<f32>, @location(1) a_idx: f32) -> UnwrapOut {
    var out: UnwrapOut;
    let l = lm_frame(u32(a_idx), inst);
    if (l.z < uni.thresh) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    out.src = l.xy;
    let uv = tile_uv(a_uv, inst);
    out.pos = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y, 0.0, 1.0);   // atlas row == uv.y
    return out;
}

@fragment
fn fs_unwrap(in: UnwrapOut) -> @location(0) vec4<f32> {
    return vec4<f32>(frame_bilinear(in.src), 1.0);
}

// \\u2500\\u2500 fullscreen quads \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

struct QOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Framebuffer-aligned uv for FILTER passes: uv.y equals the output texel's
// row so read == write and no flip accumulates.
@vertex
fn vs_quad_fb(@builtin(vertex_index) vi: u32) -> QOut {
    let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    var out: QOut;
    out.pos = vec4<f32>(p[vi], 0.0, 1.0);
    out.uv = vec2<f32>(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
    return out;
}

@fragment
fn fs_blur(in: QOut) -> @location(0) vec4<f32> {
    // dir is always \\xB11/ATLAS, so this recovers the atlas texel size.
    let tb = tile_bounds(in.uv);
    let ht = max(uni.dir.x, uni.dir.y) * 0.5;
    let lo = tb.xy + ht;
    let hi = tb.zw - ht;
    let s = max(uni.sigma, 0.001);
    let R = i32(clamp(ceil(s * 2.5), 1.0, 48.0));
    var sum = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var i = -48; i <= 48; i++) {
        if (i < -R || i > R) { continue; }
        let w = exp(-f32(i * i) / (2.0 * s * s));
        sum += textureSample(tex0, samp, clamp(in.uv + uni.dir * f32(i), lo, hi)) * w;
        wsum += w;
    }
    return sum / wsum;
}

@fragment
fn fs_combine(in: QOut) -> @location(0) vec4<f32> {
    let a  = textureSample(tex0, samp, in.uv);
    let lo = textureSample(tex1, samp, in.uv);
    return clamp(lo + (a - lo) * uni.detail, vec4<f32>(0.0), vec4<f32>(1.0));
}

// Single-pass edge-preserving bilateral (style 'bilateral'). uni.dir carries
// the 2D texel size here; range sigma 0.15 (edge stop), spatial radius \\u2264 12.
@fragment
fn fs_bilateral(in: QOut) -> @location(0) vec4<f32> {
    let btb = tile_bounds(in.uv);
    let bht = max(uni.dir.x, uni.dir.y) * 0.5;
    let blo = btb.xy + bht;
    let bhi = btb.zw - bht;
    let ss = max(uni.sigma, 0.001);
    let R = i32(clamp(ceil(ss), 1.0, 12.0));
    let sr = 0.15;
    let c = textureSample(tex0, samp, in.uv).rgb;
    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var y = -12; y <= 12; y++) {
        if (y < -R || y > R) { continue; }
        for (var x = -12; x <= 12; x++) {
            if (x < -R || x > R) { continue; }
            let sc = textureSample(tex0, samp, clamp(in.uv + uni.dir * vec2<f32>(f32(x), f32(y)), blo, bhi)).rgb;
            let ws = exp(-f32(x * x + y * y) / (2.0 * ss * ss));
            let d = sc - c;
            let wr = exp(-dot(d, d) / (2.0 * sr * sr));
            sum += sc * ws * wr;
            wsum += ws * wr;
        }
    }
    return vec4<f32>(sum / wsum, 1.0);
}

// \\u2500\\u2500 composite: passthrough + mesh over the face \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

@vertex
fn vs_pass(@builtin(vertex_index) vi: u32) -> QOut {
    let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    var out: QOut;
    out.pos = vec4<f32>(p[vi], 0.0, 1.0);
    out.uv = vec2<f32>(0.0);
    return out;
}

@fragment
fn fs_pass(in: QOut) -> @location(0) vec4<f32> {
    let i = u32(in.pos.y) * uni.frame_w + u32(in.pos.x);
    return vec4<f32>(frame_buf[i].rgb, 1.0);
}

struct CompOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,      // TILED atlas uv \\u2014 the atlas is per-face
    @location(1) src: vec2<f32>,     // frame-fraction position
    @location(2) uv_mask: vec2<f32>, // UNTILED canonical uv \\u2014 the weight mask is
                                     // one static 512\\xB2 asset shared by every face
};

@vertex
fn vs_comp(@builtin(instance_index) inst: u32,
           @location(0) a_uv: vec2<f32>, @location(1) a_idx: f32) -> CompOut {
    var out: CompOut;
    let l = lm_frame(u32(a_idx), inst);
    if (l.z < uni.thresh) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    out.uv = tile_uv(a_uv, inst);
    out.uv_mask = a_uv;
    out.src = l.xy;
    out.pos = vec4<f32>(l.x * 2.0 - 1.0, 1.0 - 2.0 * l.y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_comp(in: CompOut) -> @location(0) vec4<f32> {
    let orig = frame_bilinear(in.src);
    let sm   = textureSample(tex0, samp, in.uv).rgb;                   // smoothed atlas \\u2014 TILED
    // The weight mask is NOT tiled: it's one canonical 512\\xB2 asset, so it must be
    // sampled with the untiled uv. Using the tiled uv here made every face read
    // only its quadrant OF THE MASK, stretched over the whole face \\u2014 invisible at
    // slots=1 (tile_uv is identity) and badly wrong at slots=4.
    let w    = textureSample(tex1, samp, in.uv_mask).r * uni.strength; // weight mask \\u2014 UNTILED
    return vec4<f32>(mix(orig, sm, w), 1.0);
}

// \\u2500\\u2500 stage mode: unpack the composited float texture into the output tensor \\u2500\\u2500
// (WebGPU tensors are storage buffers; the mesh passes need a raster target.
// copyTextureToBuffer has a 256-byte bytesPerRow constraint that arbitrary
// widths violate, so a tiny compute blit does the copy instead.)

@group(0) @binding(7) var<storage, read_write> unpack_out : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn cs_unpack(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= uni.frame_w || gid.y >= uni.frame_h) { return; }
    let v = textureLoad(tex0, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    unpack_out[gid.y * uni.frame_w + gid.x] = v;
}
\`;var dr=\`enable f16;

// UV-space face touch-up (f16 storage, f32 math) \\u2014 five passes, one module:
//   unwrap    : canonical mesh \\u2192 512\\xB2 atlas; vertex at canonical UV, textured
//               by the frame at its landmark's position (vertex-pulled from the
//               landmark tensor, crop \\u2192 frame via the box tensor). The
//               rasterizer's barycentric interpolation IS the piecewise-affine
//               warp \\u2014 one draw call.
//   blur \\xD72   : separable gaussian on the atlas (freq-sep low band). Uses the
//               framebuffer-aligned vquad_fb so read row == write row and no
//               vertical flip accumulates across passes (WebGPU NDC-y is up,
//               texel rows are down).
//   combine   : low + (atlas \\u2212 low) \\xB7 detail \\u2014 smooths skin, keeps pores.
//   composite : frame passthrough, then the mesh drawn at landmark screen
//               positions sampling the smoothed atlas, blended by the static
//               weight mask \\xD7 strength. Score-gated: no face \\u2192 passthrough.
//
// Landmarks are [0,1] CROP coords; the box tensor (cx, cy, halfSide/W, score,
// frame fractions) turns them into frame fractions in the vertex shaders \\u2014
// the whole path stays GPU-resident.

struct Uni {
    frame_w  : u32,
    frame_h  : u32,
    sigma    : f32,
    detail   : f32,
    strength : f32,
    thresh   : f32,
    dir      : vec2<f32>,   // blur step (1/atlas, 0) or (0, 1/atlas)
    canvas   : vec2<f32>,   // frame w, h (aspect for the box y half-extent)
    slots    : u32,         // faces packed into lm_buf / box_buf (1 or 4)
    grid     : u32,         // atlas tile grid: 1 \\u2192 whole atlas, 2 \\u2192 2\\xD72 tiles
}

@group(0) @binding(0) var<storage, read> frame_buf : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read> lm_buf    : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read> box_buf   : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>       uni       : Uni;
@group(0) @binding(4) var samp : sampler;
@group(0) @binding(5) var tex0 : texture_2d<f32>;
@group(0) @binding(6) var tex1 : texture_2d<f32>;

// Bilinear sample of the frame tensor buffer at frame-fraction coords.
fn frame_at(px: i32, py: i32) -> vec3<f32> {
    let x = clamp(px, 0, i32(uni.frame_w) - 1);
    let y = clamp(py, 0, i32(uni.frame_h) - 1);
    return vec3<f32>(frame_buf[u32(y) * uni.frame_w + u32(x)].rgb);
}
fn frame_bilinear(f: vec2<f32>) -> vec3<f32> {
    let sx = clamp(f.x * f32(uni.frame_w) - 0.5, 0.0, f32(uni.frame_w - 1u));
    let sy = clamp(f.y * f32(uni.frame_h) - 0.5, 0.0, f32(uni.frame_h - 1u));
    let x0 = i32(floor(sx));
    let y0 = i32(floor(sy));
    let tx = sx - f32(x0);
    let ty = sy - f32(y0);
    let top = mix(frame_at(x0, y0),     frame_at(x0 + 1, y0),     tx);
    let bot = mix(frame_at(x0, y0 + 1), frame_at(x0 + 1, y0 + 1), tx);
    return mix(top, bot, ty);
}

// Landmark i \\u2192 (frame-fraction x, y, score). halfSide is a fraction of frame
// WIDTH; the y half-extent rescales by the aspect (the box is px-square).
fn lm_frame(i: u32, face: u32) -> vec3<f32> {
    let box = vec4<f32>(box_buf[face]);
    // lm_buf packs \\\`slots\\\` faces \\xD7 478 landmarks (ChannelConcat of the K
    // LandmarkNet outputs); 478 is even, so face f starts on a vec4 boundary.
    let gi = face * 478u + i;
    var g = vec4<f32>(lm_buf[gi / 2u]);
    let lx = g[(gi % 2u) * 2u];
    let ly = g[(gi % 2u) * 2u + 1u];
    let hsx = box.z;
    let hsy = box.z * uni.canvas.x / uni.canvas.y;
    return vec3<f32>((box.x - hsx) + lx * 2.0 * hsx, (box.y - hsy) + ly * 2.0 * hsy, box.w);
}

// Face \\\`face\\\` owns tile (face % grid, face / grid) of the atlas. grid=1 (K=1)
// maps to the whole atlas \\u2014 i.e. the single-face layout, unchanged.
fn tile_uv(uv: vec2<f32>, face: u32) -> vec2<f32> {
    let g = f32(uni.grid);
    return (uv + vec2<f32>(f32(face % uni.grid), f32(face / uni.grid))) / g;
}

// The tile containing \\\`uv\\\`, as (lo.x, lo.y, hi.x, hi.y) \\u2014 filter passes clamp
// their taps to it so one face's skin can't bleed into a neighbour's tile.
fn tile_bounds(uv: vec2<f32>) -> vec4<f32> {
    let g = f32(uni.grid);
    let t = floor(clamp(uv, vec2<f32>(0.0), vec2<f32>(0.99999)) * g);
    return vec4<f32>(t / g, (t + vec2<f32>(1.0, 1.0)) / g);
}

// \\u2500\\u2500 unwrap: mesh \\u2192 atlas \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

struct UnwrapOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) src: vec2<f32>,   // frame-fraction sample position
};

@vertex
fn vs_unwrap(@builtin(instance_index) inst: u32,
             @location(0) a_uv: vec2<f32>, @location(1) a_idx: f32) -> UnwrapOut {
    var out: UnwrapOut;
    let l = lm_frame(u32(a_idx), inst);
    if (l.z < uni.thresh) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    out.src = l.xy;
    let uv = tile_uv(a_uv, inst);
    out.pos = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - 2.0 * uv.y, 0.0, 1.0);   // atlas row == uv.y
    return out;
}

@fragment
fn fs_unwrap(in: UnwrapOut) -> @location(0) vec4<f32> {
    return vec4<f32>(frame_bilinear(in.src), 1.0);
}

// \\u2500\\u2500 fullscreen quads \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

struct QOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Framebuffer-aligned uv for FILTER passes: uv.y equals the output texel's
// row so read == write and no flip accumulates.
@vertex
fn vs_quad_fb(@builtin(vertex_index) vi: u32) -> QOut {
    let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    var out: QOut;
    out.pos = vec4<f32>(p[vi], 0.0, 1.0);
    out.uv = vec2<f32>(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
    return out;
}

@fragment
fn fs_blur(in: QOut) -> @location(0) vec4<f32> {
    // dir is always \\xB11/ATLAS, so this recovers the atlas texel size.
    let tb = tile_bounds(in.uv);
    let ht = max(uni.dir.x, uni.dir.y) * 0.5;
    let lo = tb.xy + ht;
    let hi = tb.zw - ht;
    let s = max(uni.sigma, 0.001);
    let R = i32(clamp(ceil(s * 2.5), 1.0, 48.0));
    var sum = vec4<f32>(0.0);
    var wsum = 0.0;
    for (var i = -48; i <= 48; i++) {
        if (i < -R || i > R) { continue; }
        let w = exp(-f32(i * i) / (2.0 * s * s));
        sum += textureSample(tex0, samp, clamp(in.uv + uni.dir * f32(i), lo, hi)) * w;
        wsum += w;
    }
    return sum / wsum;
}

@fragment
fn fs_combine(in: QOut) -> @location(0) vec4<f32> {
    let a  = textureSample(tex0, samp, in.uv);
    let lo = textureSample(tex1, samp, in.uv);
    return clamp(lo + (a - lo) * uni.detail, vec4<f32>(0.0), vec4<f32>(1.0));
}

// Single-pass edge-preserving bilateral (style 'bilateral'). uni.dir carries
// the 2D texel size here; range sigma 0.15 (edge stop), spatial radius \\u2264 12.
@fragment
fn fs_bilateral(in: QOut) -> @location(0) vec4<f32> {
    let btb = tile_bounds(in.uv);
    let bht = max(uni.dir.x, uni.dir.y) * 0.5;
    let blo = btb.xy + bht;
    let bhi = btb.zw - bht;
    let ss = max(uni.sigma, 0.001);
    let R = i32(clamp(ceil(ss), 1.0, 12.0));
    let sr = 0.15;
    let c = textureSample(tex0, samp, in.uv).rgb;
    var sum = vec3<f32>(0.0);
    var wsum = 0.0;
    for (var y = -12; y <= 12; y++) {
        if (y < -R || y > R) { continue; }
        for (var x = -12; x <= 12; x++) {
            if (x < -R || x > R) { continue; }
            let sc = textureSample(tex0, samp, clamp(in.uv + uni.dir * vec2<f32>(f32(x), f32(y)), blo, bhi)).rgb;
            let ws = exp(-f32(x * x + y * y) / (2.0 * ss * ss));
            let d = sc - c;
            let wr = exp(-dot(d, d) / (2.0 * sr * sr));
            sum += sc * ws * wr;
            wsum += ws * wr;
        }
    }
    return vec4<f32>(sum / wsum, 1.0);
}

// \\u2500\\u2500 composite: passthrough + mesh over the face \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500

@vertex
fn vs_pass(@builtin(vertex_index) vi: u32) -> QOut {
    let p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    var out: QOut;
    out.pos = vec4<f32>(p[vi], 0.0, 1.0);
    out.uv = vec2<f32>(0.0);
    return out;
}

@fragment
fn fs_pass(in: QOut) -> @location(0) vec4<f32> {
    let i = u32(in.pos.y) * uni.frame_w + u32(in.pos.x);
    return vec4<f32>(vec3<f32>(frame_buf[i].rgb), 1.0);
}

struct CompOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,      // TILED atlas uv \\u2014 the atlas is per-face
    @location(1) src: vec2<f32>,     // frame-fraction position
    @location(2) uv_mask: vec2<f32>, // UNTILED canonical uv \\u2014 the weight mask is
                                     // one static 512\\xB2 asset shared by every face
};

@vertex
fn vs_comp(@builtin(instance_index) inst: u32,
           @location(0) a_uv: vec2<f32>, @location(1) a_idx: f32) -> CompOut {
    var out: CompOut;
    let l = lm_frame(u32(a_idx), inst);
    if (l.z < uni.thresh) {
        out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
        return out;
    }
    out.uv = tile_uv(a_uv, inst);
    out.uv_mask = a_uv;
    out.src = l.xy;
    out.pos = vec4<f32>(l.x * 2.0 - 1.0, 1.0 - 2.0 * l.y, 0.0, 1.0);
    return out;
}

@fragment
fn fs_comp(in: CompOut) -> @location(0) vec4<f32> {
    let orig = frame_bilinear(in.src);
    let sm   = textureSample(tex0, samp, in.uv).rgb;                   // smoothed atlas \\u2014 TILED
    // The weight mask is NOT tiled: it's one canonical 512\\xB2 asset, so it must be
    // sampled with the untiled uv. Using the tiled uv here made every face read
    // only its quadrant OF THE MASK, stretched over the whole face \\u2014 invisible at
    // slots=1 (tile_uv is identity) and badly wrong at slots=4.
    let w    = textureSample(tex1, samp, in.uv_mask).r * uni.strength; // weight mask \\u2014 UNTILED
    return vec4<f32>(mix(orig, sm, w), 1.0);
}

// \\u2500\\u2500 stage mode: unpack the composited float texture into the output tensor \\u2500\\u2500
// (WebGPU tensors are storage buffers; the mesh passes need a raster target.
// copyTextureToBuffer has a 256-byte bytesPerRow constraint that arbitrary
// widths violate, so a tiny compute blit does the copy instead.)

@group(0) @binding(7) var<storage, read_write> unpack_out : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn cs_unpack(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= uni.frame_w || gid.y >= uni.frame_h) { return; }
    let v = textureLoad(tex0, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
    unpack_out[gid.y * uni.frame_w + gid.x] = vec4<f16>(v);
}
\`;var se=512,$e=class{constructor(e,r,t,a,o,n){i(this,"backend",e);i(this,"device");i(this,"passes");i(this,"uvBuf");i(this,"idxBuf");i(this,"slots");i(this,"activeSlots");i(this,"outputView",null);let s=n.slots??1;if(s!==1&&s!==4)throw new Error(\`FaceTouchup: slots must be 1 or 4, got \${s}\`);let p=s===4?2:1;if(a.w*a.h<s)throw new Error(\`FaceTouchup: slots \${s} exceeds the \${a.h}\\xD7\${a.w} box tensor\`);if(t.c<s*956)throw new Error(\`FaceTouchup: landmarks tensor holds \${t.c/956} faces < slots \${s}\`);this.slots=s,this.activeSlots=s;let c=e.device;this.device=c,this.uvBuf=c.createBuffer({size:o.uv.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),c.queue.writeBuffer(this.uvBuf,0,o.uv.buffer,o.uv.byteOffset,o.uv.byteLength),this.idxBuf=c.createBuffer({size:o.idx.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),c.queue.writeBuffer(this.idxBuf,0,o.idx.buffer,o.idx.byteOffset,o.idx.byteLength);let l=()=>c.createTexture({size:[se,se],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),f=l(),d=l(),_=l(),b=l(),x=c.createTexture({size:[o.weightMask.width,o.weightMask.height],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});c.queue.copyExternalImageToTexture({source:o.weightMask},{texture:x},[o.weightMask.width,o.weightMask.height]);let v=c.createSampler({magFilter:"linear",minFilter:"linear"}),y=S=>{let O=c.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),j=new ArrayBuffer(48),P=new Uint32Array(j,0,2);P[0]=r.w,P[1]=r.h;let A=new Float32Array(j,8,8);return A[0]=S.sigma??0,A[1]=n.detail,A[2]=n.strength,A[3]=n.thresh,A[4]=S.dirX??0,A[5]=S.dirY??0,A[6]=r.w,A[7]=r.h,new Uint32Array(j,40,2).set([s,p]),c.queue.writeBuffer(O,0,j),O},W=y({}),B=y({sigma:n.amount,dirX:1/se}),M=y({sigma:n.amount,dirY:1/se}),T=y({sigma:n.amount,dirX:1/se,dirY:1/se}),F=c.createShaderModule({code:e.dtype==="f16"?dr:fr}),D=[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:"float32x2"}]},{arrayStride:4,attributes:[{shaderLocation:1,offset:0,format:"float32"}]}],E=(S,O,j,P)=>c.createRenderPipeline({layout:"auto",vertex:{module:F,entryPoint:S,buffers:P?D:[]},fragment:{module:F,entryPoint:O,targets:[{format:j}]},primitive:{topology:"triangle-list"}}),R=(S,O,j)=>c.createBindGroup({layout:S.getBindGroupLayout(0),entries:[...j,{binding:3,resource:{buffer:O}}]}),q=(S,O)=>({binding:S,resource:{buffer:O}}),z=(S,O)=>({binding:S,resource:O.createView()}),H=r.buffer,V=t.buffer,X=a.buffer,re=E("vs_unwrap","fs_unwrap","rgba8unorm",!0),pe=E("vs_pass","fs_pass",e.canvasFormat,!1),ce=E("vs_comp","fs_comp",e.canvasFormat,!0),me=(n.style??"freq-sep")==="bilateral"?(()=>{let S=E("vs_quad_fb","fs_bilateral","rgba8unorm",!1);return[{pipeline:S,target:b.createView(),verts:3,mesh:!1,load:!1,bind:R(S,T,[{binding:4,resource:v},z(5,f)])}]})():(()=>{let S=E("vs_quad_fb","fs_blur","rgba8unorm",!1),O=E("vs_quad_fb","fs_combine","rgba8unorm",!1);return[{pipeline:S,target:d.createView(),verts:3,mesh:!1,load:!1,bind:R(S,B,[{binding:4,resource:v},z(5,f)])},{pipeline:S,target:_.createView(),verts:3,mesh:!1,load:!1,bind:R(S,M,[{binding:4,resource:v},z(5,d)])},{pipeline:O,target:b.createView(),verts:3,mesh:!1,load:!1,bind:R(O,W,[{binding:4,resource:v},z(5,f),z(6,_)])}]})();this.passes=[{pipeline:re,target:f.createView(),verts:o.count,mesh:!0,load:!1,bind:R(re,W,[q(0,H),q(1,V),q(2,X)])},...me,{pipeline:pe,target:null,verts:3,mesh:!1,load:!1,bind:R(pe,W,[q(0,H)])},{pipeline:ce,target:null,verts:o.count,mesh:!0,load:!0,bind:R(ce,W,[q(0,H),q(1,V),q(2,X),{binding:4,resource:v},z(5,b),z(6,x)])}]}setOutput(e){this.outputView=e.createView()}run(){if(!this.outputView)throw new Error("FaceTouchupWebGPU.run() called before setOutput()");let e=this.device.createCommandEncoder();for(let r of this.passes){let t=e.beginRenderPass({colorAttachments:[{view:r.target??this.outputView,clearValue:[0,0,0,1],loadOp:r.load?"load":"clear",storeOp:"store"}]});t.setPipeline(r.pipeline),t.setBindGroup(0,r.bind),r.mesh&&(t.setVertexBuffer(0,this.uvBuf),t.setVertexBuffer(1,this.idxBuf)),t.draw(r.verts,r.mesh?this.activeSlots:1),t.end()}this.device.queue.submit([e.finish()]),this.outputView=null}},Ke=class{constructor(e,r,t,a,o,n){i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"device");i(this,"passes");i(this,"unpackPipeline");i(this,"unpackBind");i(this,"unpackDispatch");i(this,"uvBuf");i(this,"idxBuf");i(this,"meshCount");i(this,"slots");i(this,"activeSlots");let p=n.slots??1;if(p!==1&&p!==4)throw new Error(\`FaceTouchup: slots must be 1 or 4, got \${p}\`);let c=p===4?2:1;if(a.w*a.h<p)throw new Error(\`FaceTouchup: slots \${p} exceeds the \${a.h}\\xD7\${a.w} box tensor\`);if(t.c<p*956)throw new Error(\`FaceTouchup: landmarks tensor holds \${t.c/956} faces < slots \${p}\`);this.slots=p,this.activeSlots=p;let l=e.device;this.device=l,this.inputs=[r,t,a],this.output=e.tensor(r.h,r.w,4),this.meshCount=o.count,this.uvBuf=l.createBuffer({size:o.uv.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),l.queue.writeBuffer(this.uvBuf,0,o.uv.buffer,o.uv.byteOffset,o.uv.byteLength),this.idxBuf=l.createBuffer({size:o.idx.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),l.queue.writeBuffer(this.idxBuf,0,o.idx.buffer,o.idx.byteOffset,o.idx.byteLength);let f=()=>l.createTexture({size:[512,512],format:"rgba8unorm",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),d=f(),_=f(),b=f(),x=f(),v=e.dtype==="f16"?"rgba16float":"rgba32float",y=l.createTexture({size:[r.w,r.h],format:v,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),W=l.createTexture({size:[o.weightMask.width,o.weightMask.height],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});l.queue.copyExternalImageToTexture({source:o.weightMask},{texture:W},[o.weightMask.width,o.weightMask.height]);let B=l.createSampler({magFilter:"linear",minFilter:"linear"}),M=P=>{let A=l.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),$=new ArrayBuffer(48),he=new Uint32Array($,0,2);he[0]=r.w,he[1]=r.h;let K=new Float32Array($,8,8);return K[0]=P.sigma??0,K[1]=n.detail,K[2]=n.strength,K[3]=n.thresh,K[4]=P.dirX??0,K[5]=P.dirY??0,K[6]=r.w,K[7]=r.h,new Uint32Array($,40,2).set([p,c]),l.queue.writeBuffer(A,0,$),A},T=M({}),F=M({sigma:n.amount,dirX:1/512}),D=M({sigma:n.amount,dirY:1/512}),E=M({sigma:n.amount,dirX:1/512,dirY:1/512}),R=l.createShaderModule({code:e.dtype==="f16"?dr:fr}),q=[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:"float32x2"}]},{arrayStride:4,attributes:[{shaderLocation:1,offset:0,format:"float32"}]}],z=(P,A,$,he)=>l.createRenderPipeline({layout:"auto",vertex:{module:R,entryPoint:P,buffers:he?q:[]},fragment:{module:R,entryPoint:A,targets:[{format:$}]},primitive:{topology:"triangle-list"}}),H=(P,A,$)=>l.createBindGroup({layout:P.getBindGroupLayout(0),entries:[...$,{binding:3,resource:{buffer:A}}]}),V=(P,A)=>({binding:P,resource:{buffer:A}}),X=(P,A)=>({binding:P,resource:A.createView()}),re=r.buffer,pe=t.buffer,ce=a.buffer,me=z("vs_unwrap","fs_unwrap","rgba8unorm",!0),S=z("vs_pass","fs_pass",v,!1),O=z("vs_comp","fs_comp",v,!0),j=(n.style??"freq-sep")==="bilateral"?(()=>{let P=z("vs_quad_fb","fs_bilateral","rgba8unorm",!1);return[{pipeline:P,target:x.createView(),verts:3,mesh:!1,load:!1,bind:H(P,E,[{binding:4,resource:B},X(5,d)])}]})():(()=>{let P=z("vs_quad_fb","fs_blur","rgba8unorm",!1),A=z("vs_quad_fb","fs_combine","rgba8unorm",!1);return[{pipeline:P,target:_.createView(),verts:3,mesh:!1,load:!1,bind:H(P,F,[{binding:4,resource:B},X(5,d)])},{pipeline:P,target:b.createView(),verts:3,mesh:!1,load:!1,bind:H(P,D,[{binding:4,resource:B},X(5,_)])},{pipeline:A,target:x.createView(),verts:3,mesh:!1,load:!1,bind:H(A,T,[{binding:4,resource:B},X(5,d),X(6,b)])}]})();this.passes=[{pipeline:me,target:d.createView(),verts:o.count,mesh:!0,load:!1,bind:H(me,T,[V(0,re),V(1,pe),V(2,ce)])},...j,{pipeline:S,target:y.createView(),verts:3,mesh:!1,load:!1,bind:H(S,T,[V(0,re)])},{pipeline:O,target:y.createView(),verts:o.count,mesh:!0,load:!0,bind:H(O,T,[V(0,re),V(1,pe),V(2,ce),{binding:4,resource:B},X(5,x),X(6,W)])}],this.unpackPipeline=l.createComputePipeline({layout:"auto",compute:{module:R,entryPoint:"cs_unpack"}}),this.unpackBind=H(this.unpackPipeline,T,[X(5,y),V(7,this.output.buffer)]),this.unpackDispatch=[Math.ceil(r.w/8),Math.ceil(r.h/8)]}setActiveSlots(e){this.activeSlots=Math.max(0,Math.min(e,this.slots))}run(){let e=this.device.createCommandEncoder();for(let t of this.passes){let a=e.beginRenderPass({colorAttachments:[{view:t.target,clearValue:[0,0,0,1],loadOp:t.load?"load":"clear",storeOp:"store"}]});a.setPipeline(t.pipeline),a.setBindGroup(0,t.bind),t.mesh&&(a.setVertexBuffer(0,this.uvBuf),a.setVertexBuffer(1,this.idxBuf)),a.draw(t.verts,t.mesh?this.activeSlots:1),a.end()}let r=e.beginComputePass();r.setPipeline(this.unpackPipeline),r.setBindGroup(0,this.unpackBind),r.dispatchWorkgroups(this.unpackDispatch[0],this.unpackDispatch[1],1),r.end(),this.device.queue.submit([e.finish()])}};var eo=\`// Flow-gated temporal stabilizer (f32). See stabilize_f16.wgsl for the math.

struct Params {
    h        : u32,
    w        : u32,
    t_lo     : f32,
    t_hi     : f32,
    leak     : f32,
    release  : f32,
    t_div    : f32,
    div_scale: f32,
    step_x   : u32,
    step_y   : u32,
}

@group(0) @binding(0) var<storage, read>       flow_buf     : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       pred_buf     : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       ref_buf      : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read>       env_prev_buf : array<vec4<f32>>;
@group(0) @binding(4) var<uniform>             params       : Params;
@group(0) @binding(5) var<storage, read_write> output_buf   : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }
    let idx = y * params.w + x;

    let mag      = length(flow_buf[idx].xy);
    let env_prev = env_prev_buf[idx].y;
    let env      = max(mag, params.release * env_prev);

    let xr = min(x + params.step_x, params.w - 1u);
    let xl = select(x - params.step_x, 0u, x < params.step_x);
    let yd = min(y + params.step_y, params.h - 1u);
    let yu = select(y - params.step_y, 0u, y < params.step_y);
    let dfx = flow_buf[y * params.w + xr].x - flow_buf[y * params.w + xl].x;
    let dfy = flow_buf[yd * params.w + x].y - flow_buf[yu * params.w + x].y;
    let divg = abs(dfx + dfy);

    let g_mag = clamp((env - params.t_lo) / max(params.t_hi - params.t_lo, 1e-3), 0.0, 1.0);
    let g_div = clamp((divg - params.t_div) / max(params.div_scale, 1e-3), 0.0, 1.0);
    let g = max(max(g_mag, g_div), params.leak);

    let pred = pred_buf[idx].x;
    let refv = ref_buf[idx].x;
    let stab = g * pred + (1.0 - g) * refv;

    output_buf[idx] = vec4<f32>(stab, env, 0.0, 0.0);
}
\`;var to=\`enable f16;

// Flow-gated temporal stabilizer (f16 storage, f32 gate math). Per pixel:
//   env = max(|flow.xy|, release\\xB7envPrev.y)      peak-hold (fast attack, slow release)
//   div = |\\u2202fx/\\u2202x + \\u2202fy/\\u2202y|                       flow divergence (occlusion seam)
//   g   = max(clamp((env-tLo)/(tHi-tLo),0,1), clamp((div-tDiv)/divScale,0,1), leak)
//   out = vec4((g\\xB7pred + (1-g)\\xB7ref).x, env, 0, 0)
// The divergence term opens the gate at occlusion/disocclusion boundaries (where
// the flow tears but the revealed-background magnitude is ~0). Finite-difference
// step spans ~1 base/4 pixel. alpha is in .x of pred/ref; env threads via .y.

struct Params {
    h        : u32,
    w        : u32,
    t_lo     : f32,
    t_hi     : f32,
    leak     : f32,
    release  : f32,
    t_div    : f32,
    div_scale: f32,
    step_x   : u32,
    step_y   : u32,
}

@group(0) @binding(0) var<storage, read>       flow_buf     : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       pred_buf     : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       ref_buf      : array<vec4<f16>>;
@group(0) @binding(3) var<storage, read>       env_prev_buf : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             params       : Params;
@group(0) @binding(5) var<storage, read_write> output_buf   : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }
    let idx = y * params.w + x;

    let mag      = length(vec2<f32>(flow_buf[idx].xy));
    let env_prev = f32(env_prev_buf[idx].y);
    let env      = max(mag, params.release * env_prev);

    // Flow divergence over a \\xB1step finite-difference (clamped to the edges).
    let xr = min(x + params.step_x, params.w - 1u);
    let xl = select(x - params.step_x, 0u, x < params.step_x);
    let yd = min(y + params.step_y, params.h - 1u);
    let yu = select(y - params.step_y, 0u, y < params.step_y);
    let dfx = f32(flow_buf[y * params.w + xr].x) - f32(flow_buf[y * params.w + xl].x);
    let dfy = f32(flow_buf[yd * params.w + x].y) - f32(flow_buf[yu * params.w + x].y);
    let divg = abs(dfx + dfy);

    let g_mag = clamp((env - params.t_lo) / max(params.t_hi - params.t_lo, 1e-3), 0.0, 1.0);
    let g_div = clamp((divg - params.t_div) / max(params.div_scale, 1e-3), 0.0, 1.0);
    let g = max(max(g_mag, g_div), params.leak);

    let pred = f32(pred_buf[idx].x);
    let refv = f32(ref_buf[idx].x);
    let stab = g * pred + (1.0 - g) * refv;

    output_buf[idx] = vec4<f16>(f16(stab), f16(env), 0.0h, 0.0h);
}
\`;var Ye=class extends h{constructor(r,t,a,o,n,s){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?to:eo,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a,o,n],this.createUniform("params","Params");let p=new Uint32Array(10);p[0]=t.h,p[1]=t.w;let c=new Float32Array(p.buffer);c[2]=s.tLo,c[3]=s.tHi,c[4]=s.leak,c[5]=s.release,c[6]=s.tDiv,c[7]=s.divScale,p[8]=s.stepX,p[9]=s.stepY,this.setUniform("params",p),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var ro=\`// Bilinear upsample (arbitrary ratio), align_corners=False (matches PyTorch default).
// Input/output in NHWC vec4 format: index = y*W*(C/4) + x*(C/4) + c_group.
// Each thread computes one output pixel for one channel group (vec4 = 4 channels).

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    _pad0          : u32,
    _pad1          : u32,
    _pad2          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let IH = params.in_h;
    let IW = params.in_w;
    let C  = params.channel_groups;

    // align_corners=False: src = (out + 0.5) * (in / out) - 0.5
    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    // Clamp to [0, in-1] for border replication. Use i32 intermediates so that
    // floor() returning -1.0 doesn't produce an invalid u32 conversion.
    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    let tl = input_buf[y0 * IW * C + x0 * C + c];
    let tr = input_buf[y0 * IW * C + x1 * C + c];
    let bl = input_buf[y1 * IW * C + x0 * C + c];
    let br = input_buf[y1 * IW * C + x1 * C + c];

    // Bilinear blend \\u2014 vec4 ops are element-wise, so all 4 channels blend identically.
    let result = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
               +        wy  * ((1.0 - wx) * bl + wx * br);

    output_buf[oy * params.out_w * C + ox * C + c] = result;
}
\`;var oo=\`enable f16;

// Bilinear upsample 2\\xD7 \\u2014 full f16 variant.
// Interpolation weights (wx, wy) and intermediate blends computed in f32 for
// accuracy; result cast to f16 on write.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    _pad0          : u32,
    _pad1          : u32,
    _pad2          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let IH = params.in_h;
    let IW = params.in_w;
    let C  = params.channel_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    let tl = vec4<f32>(input_buf[y0 * IW * C + x0 * C + c]);
    let tr = vec4<f32>(input_buf[y0 * IW * C + x1 * C + c]);
    let bl = vec4<f32>(input_buf[y1 * IW * C + x0 * C + c]);
    let br = vec4<f32>(input_buf[y1 * IW * C + x1 * C + c]);

    let result = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
               +        wy  * ((1.0 - wx) * bl + wx * br);

    output_buf[oy * params.out_w * C + ox * C + c] = vec4<f16>(result);
}
\`;var Qe=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?oo:ro;let o=t.c/4;this.output=r.tensor(a.outH,a.outW,t.c),this.inputs=[t],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,a.outH,a.outW,o,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(a.outW/8),Math.ceil(a.outH/8),o]}};var ao=\`// Top-left crop (f32). See crop_f16.wgsl.

struct Params {
    in_w   : u32,
    out_h  : u32,
    out_w  : u32,
    groups : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let g = gid.z;
    if (x >= params.out_w || y >= params.out_h || g >= params.groups) { return; }
    let G = params.groups;
    output_buf[y * params.out_w * G + x * G + g] = input_buf[y * params.in_w * G + x * G + g];
}
\`;var io=\`enable f16;

// Top-left crop: output[y,x,g] = input[y,x,g] for y<outH, x<outW (training crop_like).

struct Params {
    in_w   : u32,
    out_h  : u32,
    out_w  : u32,
    groups : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let g = gid.z;
    if (x >= params.out_w || y >= params.out_h || g >= params.groups) { return; }
    let G = params.groups;
    output_buf[y * params.out_w * G + x * G + g] = input_buf[y * params.in_w * G + x * G + g];
}
\`;var Je=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?io:ao;let o=t.c/4;this.output=r.tensor(a.outH,a.outW,t.c),this.inputs=[t],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.w,a.outH,a.outW,o])),this.defaultSetup(),this.dispatch=[Math.ceil(a.outW/8),Math.ceil(a.outH/8),o]}};var so=\`// Bicubic upsample (arbitrary scale) \\u2014 Keys cubic, a=-0.75 (PyTorch default
// for mode='bicubic', align_corners=False). Direct 2D, 4\\xD74 = 16 taps per
// output pixel. NHWC vec4 layout: index = y*W*(C/4) + x*(C/4) + c_group.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    _pad0          : u32,
    _pad1          : u32,
    _pad2          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f32>>;

const A: f32 = -0.75;

fn wcubic(d: f32) -> f32 {
    let ad = abs(d);
    if (ad <= 1.0) { return ((A + 2.0) * ad - (A + 3.0)) * ad * ad + 1.0; }
    if (ad <  2.0) { return ((A * ad - 5.0 * A) * ad + 8.0 * A) * ad - 4.0 * A; }
    return 0.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let IH = params.in_h;
    let IW = params.in_w;
    let C  = params.channel_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = i32(floor(src_x));
    let y0 = i32(floor(src_y));
    let fx = src_x - f32(x0);
    let fy = src_y - f32(y0);

    var wx: array<f32, 4>;
    var wy: array<f32, 4>;
    wx[0] = wcubic(1.0 + fx); wx[1] = wcubic(fx); wx[2] = wcubic(1.0 - fx); wx[3] = wcubic(2.0 - fx);
    wy[0] = wcubic(1.0 + fy); wy[1] = wcubic(fy); wy[2] = wcubic(1.0 - fy); wy[3] = wcubic(2.0 - fy);

    var acc: vec4<f32> = vec4<f32>(0.0);
    for (var j: i32 = 0; j < 4; j = j + 1) {
        let sy = u32(clamp(y0 + j - 1, 0, i32(IH) - 1));
        for (var i: i32 = 0; i < 4; i = i + 1) {
            let sx = u32(clamp(x0 + i - 1, 0, i32(IW) - 1));
            let v  = input_buf[sy * IW * C + sx * C + c];
            acc = acc + (wx[i] * wy[j]) * v;
        }
    }

    output_buf[oy * params.out_w * C + ox * C + c] = acc;
}
\`;var no=\`enable f16;

// Bicubic upsample \\u2014 full f16 storage variant. Bicubic weights and the per-
// pixel accumulator are computed in f32 (cheap to keep precision around the
// kernel arithmetic), then demoted to f16 when written to the output buffer.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    _pad0          : u32,
    _pad1          : u32,
    _pad2          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f16>>;

const A: f32 = -0.75;

fn wcubic(d: f32) -> f32 {
    let ad = abs(d);
    if (ad <= 1.0) { return ((A + 2.0) * ad - (A + 3.0)) * ad * ad + 1.0; }
    if (ad <  2.0) { return ((A * ad - 5.0 * A) * ad + 8.0 * A) * ad - 4.0 * A; }
    return 0.0;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let IH = params.in_h;
    let IW = params.in_w;
    let C  = params.channel_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = i32(floor(src_x));
    let y0 = i32(floor(src_y));
    let fx = src_x - f32(x0);
    let fy = src_y - f32(y0);

    var wx: array<f32, 4>;
    var wy: array<f32, 4>;
    wx[0] = wcubic(1.0 + fx); wx[1] = wcubic(fx); wx[2] = wcubic(1.0 - fx); wx[3] = wcubic(2.0 - fx);
    wy[0] = wcubic(1.0 + fy); wy[1] = wcubic(fy); wy[2] = wcubic(1.0 - fy); wy[3] = wcubic(2.0 - fy);

    var acc: vec4<f32> = vec4<f32>(0.0);
    for (var j: i32 = 0; j < 4; j = j + 1) {
        let sy = u32(clamp(y0 + j - 1, 0, i32(IH) - 1));
        for (var i: i32 = 0; i < 4; i = i + 1) {
            let sx = u32(clamp(x0 + i - 1, 0, i32(IW) - 1));
            let v  = vec4<f32>(input_buf[sy * IW * C + sx * C + c]);
            acc = acc + (wx[i] * wy[j]) * v;
        }
    }

    output_buf[oy * params.out_w * C + ox * C + c] = vec4<f16>(acc);
}
\`;var Ze=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?no:so;let o=t.c/4;this.output=r.tensor(a.outH,a.outW,t.c),this.inputs=[t],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,a.outH,a.outW,o,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(a.outW/8),Math.ceil(a.outH/8),o]}};var uo=\`// Channel concatenation: output = cat(A, B, dim=channel).
// Both A and B must share the same H\\xD7W and be in NHWC vec4 format.
// Output layout: for each (y, x), the first a_groups vec4s come from A,
// followed by b_groups vec4s from B.

struct Params {
    height    : u32,
    width     : u32,
    a_groups  : u32,  // Ca / 4
    b_groups  : u32,  // Cb / 4
    out_groups: u32,  // a_groups + b_groups
    _pad0     : u32,
    _pad1     : u32,
    _pad2     : u32,
}

@group(0) @binding(0) var<storage, read>       input_a    : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       input_b    : array<vec4<f32>>;
@group(0) @binding(2) var<uniform>             params     : Params;
@group(0) @binding(3) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let c = gid.z;  // output channel group

    let W   = params.width;
    let Ag  = params.a_groups;
    let Bg  = params.b_groups;
    let Cg  = params.out_groups;

    if (x >= W || y >= params.height || c >= Cg) {
        return;
    }

    let out_idx = y * W * Cg + x * Cg + c;

    if (c < Ag) {
        output_buf[out_idx] = input_a[y * W * Ag + x * Ag + c];
    } else {
        let c_b = c - Ag;
        output_buf[out_idx] = input_b[y * W * Bg + x * Bg + c_b];
    }
}
\`;var po=\`enable f16;

// Channel concatenation \\u2014 full f16 variant.

struct Params {
    height    : u32,
    width     : u32,
    a_groups  : u32,
    b_groups  : u32,
    out_groups: u32,
    _pad0     : u32,
    _pad1     : u32,
    _pad2     : u32,
}

@group(0) @binding(0) var<storage, read>       input_a    : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       input_b    : array<vec4<f16>>;
@group(0) @binding(2) var<uniform>             params     : Params;
@group(0) @binding(3) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let c = gid.z;

    let W  = params.width;
    let Ag = params.a_groups;
    let Bg = params.b_groups;
    let Cg = params.out_groups;

    if (x >= W || y >= params.height || c >= Cg) { return; }

    let out_idx = y * W * Cg + x * Cg + c;
    if (c < Ag) {
        output_buf[out_idx] = input_a[y * W * Ag + x * Ag + c];
    } else {
        let c_b = c - Ag;
        output_buf[out_idx] = input_b[y * W * Bg + x * Bg + c_b];
    }
}
\`;var et=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?po:uo;let o=t.c/4,n=a.c/4,s=o+n;this.output=r.tensor(t.h,t.w,t.c+a.c),this.inputs=[t,a],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,o,n,s,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),s]}};var co=\`// Conv2d + skip add fused.
// Identical to conv2d.wgsl except skip is an activation input (binding 1),
// added element-wise to the conv result at write time.
// Eliminates the separate add dispatch and its intermediate buffer round-trip.
// Binding order: input(0), skip(1), weights(2), bias(3), params(4), output(5)

struct Params {
    in_h        : u32,
    in_w        : u32,
    out_h       : u32,
    out_w       : u32,
    in_groups   : u32,
    out_groups  : u32,
    kernel_h    : u32,
    kernel_w    : u32,
    stride      : u32,
    pad_top     : u32,
    pad_left    : u32,
    activation  : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       skip_buf   : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat4x4<f32>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let o = gid.z;

    if (x >= params.out_w || y >= params.out_h || o >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;

    var result = bias_buf[o];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let in_y_s = i32(y * params.stride + ky) - i32(params.pad_top);
            let in_x_s = i32(x * params.stride + kx) - i32(params.pad_left);

            if (in_y_s < 0 || in_x_s < 0 ||
                u32(in_y_s) >= params.in_h || u32(in_x_s) >= params.in_w) {
                continue;
            }

            let in_y = u32(in_y_s);
            let in_x = u32(in_x_s);
            let z    = ky * params.kernel_w + kx;

            for (var i = 0u; i < I; i++) {
                let in_idx = in_y * params.in_w * I + in_x * I + i;
                let w_idx  = z * O * I + o * I + i;
                result += weight_buf[w_idx] * input_buf[in_idx];
            }
        }
    }

    if (params.activation == 1u) {
        result = clamp(result, vec4<f32>(0.0), vec4<f32>(6.0));
    } else if (params.activation == 2u) {
        result = max(result, vec4<f32>(0.0));
    }

    let out_idx = y * params.out_w * O + x * O + o;
    output_buf[out_idx] = result + skip_buf[out_idx];
}
\`;var lo=\`enable f16;

// Conv2d + skip add fused \\u2014 full f16 variant.

struct Params {
    in_h        : u32,
    in_w        : u32,
    out_h       : u32,
    out_w       : u32,
    in_groups   : u32,
    out_groups  : u32,
    kernel_h    : u32,
    kernel_w    : u32,
    stride      : u32,
    pad_top     : u32,
    pad_left    : u32,
    activation  : u32,
}

// Binding order matches conv2d_add.wgsl: input(0), skip(1), weight(2), bias(3),
// params(4), output(5).
@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       skip_buf   : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat4x4<f16>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let o = gid.z;

    if (x >= params.out_w || y >= params.out_h || o >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;

    var result = bias_buf[o];

    for (var ky = 0u; ky < params.kernel_h; ky++) {
        for (var kx = 0u; kx < params.kernel_w; kx++) {
            let in_y_s = i32(y * params.stride + ky) - i32(params.pad_top);
            let in_x_s = i32(x * params.stride + kx) - i32(params.pad_left);

            if (in_y_s < 0 || in_x_s < 0 ||
                u32(in_y_s) >= params.in_h || u32(in_x_s) >= params.in_w) {
                continue;
            }

            let in_y = u32(in_y_s);
            let in_x = u32(in_x_s);
            let z    = ky * params.kernel_w + kx;

            for (var i = 0u; i < I; i++) {
                let in_idx = in_y * params.in_w * I + in_x * I + i;
                let w_idx  = z * O * I + o * I + i;
                result += weight_buf[w_idx] * input_buf[in_idx];
            }
        }
    }

    if (params.activation == 1u) {
        result = clamp(result, vec4<f16>(0.0h), vec4<f16>(6.0h));
    } else if (params.activation == 2u) {
        result = max(result, vec4<f16>(0.0h));
    }

    let out_idx = y * params.out_w * O + x * O + o;
    output_buf[out_idx] = result + skip_buf[out_idx];
}
\`;var tt=class extends h{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?lo:co;let s=C(t.h,n.kernel,n.stride,n.padding),p=C(t.w,n.kernel,n.stride,n.padding),c=t.c/4,l=n.outChannels/4,f=G(n.padding,t.h,s,n.kernel,n.stride),d=G(n.padding,t.w,p,n.kernel,n.stride);this.output=r.tensor(s,p,n.outChannels),this.inputs=[t,a],this.weights=[r.upload(m(o.weights)),r.upload(m(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,s,p,c,l,n.kernel,n.kernel,n.stride,f,d,n.activation==="relu6"?1:0])),this.defaultSetup(),this.dispatch=[Math.ceil(p/8),Math.ceil(s/8),l]}};var fo=\`// proj_residual: bespoke 1\\xD71 conv (no activation) + residual add, fused.
// Specializes conv2d_add to kernel=1 / stride=1 / pad=0 / no activation: drops
// the kernel loop, the padding checks, and the activation branch. Used by the
// MBConv project+residual tail. Both inputs share the same spatial resolution.
//
// Weight layout: [out_groups][in_groups] mat4x4 (no K*K dim since K=1).
// Bias: [out_groups] vec4.
// Binding order: input(0), skip(1), weights(2), bias(3), params(4), output(5)

struct Params {
    h          : u32,
    w          : u32,
    in_groups  : u32,
    out_groups : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       skip_buf   : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat4x4<f32>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let o = gid.z;

    if (x >= params.w || y >= params.h || o >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;
    let pix = y * params.w + x;

    var result = bias_buf[o];
    for (var i = 0u; i < I; i++) {
        result += weight_buf[o * I + i] * input_buf[pix * I + i];
    }
    result += skip_buf[pix * O + o];

    output_buf[pix * O + o] = result;
}
\`;var mo=\`enable f16;

// proj_residual \\u2014 full f16 variant. See proj_residual.wgsl for layout details.
// Bespoke 1\\xD71 conv (no activation) + residual add, fused.
// Binding order: input(0), skip(1), weights(2), bias(3), params(4), output(5)

struct Params {
    h          : u32,
    w          : u32,
    in_groups  : u32,
    out_groups : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       skip_buf   : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat4x4<f16>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    let o = gid.z;

    if (x >= params.w || y >= params.h || o >= params.out_groups) {
        return;
    }

    let I = params.in_groups;
    let O = params.out_groups;
    let pix = y * params.w + x;

    var result = bias_buf[o];
    for (var i = 0u; i < I; i++) {
        result += weight_buf[o * I + i] * input_buf[pix * I + i];
    }
    result += skip_buf[pix * O + o];

    output_buf[pix * O + o] = result;
}
\`;var rt=class extends h{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?mo:fo;let s=t.c/4,p=n.outChannels/4;this.output=r.tensor(t.h,t.w,n.outChannels),this.inputs=[t,a],this.weights=[r.upload(m(o.weights)),r.upload(m(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,s,p])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),p]}};var ho=\`// concat_conv2d: fuses [concat(a, b) \\u2192 conv 3\\xD73 (pad 1) \\u2192 relu6] into one
// dispatch. Both inputs are already at the output resolution (the upstream
// upsample stays a separate dispatch writing a clean intermediate, so the conv
// reads are plain-indexed). Identical math to conv2d; the only difference is
// that input channels are split across two buffers: weight cols [0, a_groups)
// read a, [a_groups, I) read b.
//
// Weight layout matches conv2d: [kpos][out_groups][in_groups] mat4x4, where
// in_groups = a_groups + b_groups and the input channel order is [a, b].
// Binding order: a(0), b(1), weights(2), bias(3), params(4), output(5)

struct Params {
    h          : u32,   // a, b and output all share this shape
    w          : u32,
    a_groups   : u32,
    b_groups   : u32,
    out_groups : u32,
    _pad0      : u32,
    _pad1      : u32,
    _pad2      : u32,
}

@group(0) @binding(0) var<storage, read>       buf_a      : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       buf_b      : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat4x4<f32>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(4) var<uniform>             p          : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y; let o = gid.z;
    if (x >= p.w || y >= p.h || o >= p.out_groups) { return; }

    let A = p.a_groups;
    let B = p.b_groups;
    let I = A + B;
    let O = p.out_groups;

    var result = bias_buf[o];

    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let nx = i32(x + kx) - 1;
            let ny = i32(y + ky) - 1;
            if (nx < 0 || ny < 0 || u32(nx) >= p.w || u32(ny) >= p.h) { continue; }
            let z   = ky * 3u + kx;
            let pix = u32(ny) * p.w + u32(nx);
            for (var i = 0u; i < A; i++) {
                result += weight_buf[z * O * I + o * I + i] * buf_a[pix * A + i];
            }
            for (var i = 0u; i < B; i++) {
                result += weight_buf[z * O * I + o * I + (A + i)] * buf_b[pix * B + i];
            }
        }
    }

    result = clamp(result, vec4<f32>(0.0), vec4<f32>(6.0));
    output_buf[(y * p.w + x) * O + o] = result;
}
\`;var go=\`enable f16;

// concat_conv2d \\u2014 full f16 variant. See concat_conv2d.wgsl for layout details.
// Fuses [concat(a, b) \\u2192 conv 3\\xD73 (pad 1) \\u2192 relu6] into one dispatch.
// Binding order: a(0), b(1), weights(2), bias(3), params(4), output(5)

struct Params {
    h          : u32,
    w          : u32,
    a_groups   : u32,
    b_groups   : u32,
    out_groups : u32,
    _pad0      : u32,
    _pad1      : u32,
    _pad2      : u32,
}

@group(0) @binding(0) var<storage, read>       buf_a      : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       buf_b      : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat4x4<f16>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             p          : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y; let o = gid.z;
    if (x >= p.w || y >= p.h || o >= p.out_groups) { return; }

    let A = p.a_groups;
    let B = p.b_groups;
    let I = A + B;
    let O = p.out_groups;

    var result = bias_buf[o];

    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let nx = i32(x + kx) - 1;
            let ny = i32(y + ky) - 1;
            if (nx < 0 || ny < 0 || u32(nx) >= p.w || u32(ny) >= p.h) { continue; }
            let z   = ky * 3u + kx;
            let pix = u32(ny) * p.w + u32(nx);
            for (var i = 0u; i < A; i++) {
                result += weight_buf[z * O * I + o * I + i] * buf_a[pix * A + i];
            }
            for (var i = 0u; i < B; i++) {
                result += weight_buf[z * O * I + o * I + (A + i)] * buf_b[pix * B + i];
            }
        }
    }

    result = clamp(result, vec4<f16>(0.0h), vec4<f16>(6.0h));
    output_buf[(y * p.w + x) * O + o] = result;
}
\`;var ot=class extends h{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?go:ho;let s=t.c/4,p=a.c/4,c=n.outChannels/4;this.output=r.tensor(t.h,t.w,n.outChannels),this.inputs=[t,a],this.weights=[r.upload(m(o.weights)),r.upload(m(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,s,p,c,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),c]}};var _o=\`// gates_fused: ConvGRU z + r gates, fused into one dispatch.
// Production config (c_up=2, split_ratio=0.5 \\u2192 passthrough=1, recurrent=1):
//   u_in   : c_up=2 packed in a vec4 (.x = passthrough a, .y = recurrent b)
//   h_prev : hidden carrier \\u2014 recurrent state in .z (see cand_update_fused: the
//            GRU output tensor doubles as next frame's h_prev, hidden in .z)
// Weight: 9 vec4 per kpos = (z_w_b, z_w_h, r_w_b, r_w_h). Bias .xy = (z, r).
// Output: vec4(z, r, 0, 0) \\u2014 consumed by cand_update_fused.
// Binding order: u_in(0), h_prev(1), weights(2), bias(3), params(4), output(5)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_in_buf   : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       h_prev_buf : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<vec4<f32>>;   // 9 vec4
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f32>>;   // .xy = (z, r)
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    let bias = bias_buf[0].xy;
    var z_pre = bias.x;
    var r_pre = bias.y;

    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let idx  = u32(iy) * params.w + u32(ix);
            let b_n  = u_in_buf[idx].y;
            let h_n  = h_prev_buf[idx].z;
            let w    = weight_buf[kpos];
            z_pre += w.x * b_n + w.y * h_n;
            r_pre += w.z * b_n + w.w * h_n;
        }
    }

    let z = 1.0 / (1.0 + exp(-z_pre));
    let r = 1.0 / (1.0 + exp(-r_pre));
    output_buf[y * params.w + x] = vec4<f32>(z, r, 0.0, 0.0);
}
\`;var bo=\`enable f16;

// gates_fused \\u2014 full f16 variant. See gates_fused.wgsl for layout details.
// ConvGRU z + r gates (production config c_up=2, recurrent=1).
// Binding order: u_in(0), h_prev(1), weights(2), bias(3), params(4), output(5)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_in_buf   : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       h_prev_buf : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<vec4<f16>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    let bias = bias_buf[0].xy;
    var z_pre = bias.x;
    var r_pre = bias.y;

    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let idx  = u32(iy) * params.w + u32(ix);
            let b_n  = u_in_buf[idx].y;
            let h_n  = h_prev_buf[idx].z;
            let w    = weight_buf[kpos];
            z_pre += w.x * b_n + w.y * h_n;
            r_pre += w.z * b_n + w.w * h_n;
        }
    }

    let z = 1.0h / (1.0h + exp(-z_pre));
    let r = 1.0h / (1.0h + exp(-r_pre));
    output_buf[y * params.w + x] = vec4<f16>(z, r, 0.0h, 0.0h);
}
\`;var at=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?bo:_o,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a],this.weights=[r.upload(m(o.weights)),r.upload(w(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var vo=\`// cand_update_fused: ConvGRU candidate path + state update + output, fused.
// Production config (c_up=2, recurrent=1):
//   u_in      : c_up=2 (.x = a passthrough, .y = b recurrent)
//   h_prev    : hidden carrier \\u2014 recurrent state in .z (the previous frame's
//               output of THIS op; on frame 0 it is a zero tensor)
//   gates_out : (.x = z, .y = r) from gates_fused
// cand_pre = bias + \\u03A3_kpos (b_w*b_n + rh_w*(r_n*h_n));  h_til = tanh(cand_pre);
//   h_new = (1-z)*h_prev + z*h_til;  b_out = b + gamma*h_new.
// Output: vec4(a, b_out, h_new, 0) \\u2014 .xy is the c_up=2 feature consumed
// downstream; .z carries h_new so the same tensor is fed back as next h_prev
// (no separate hidden-state buffer). Cand weight: 9 vec4 per kpos, .xy = (b_w, rh_w).
// Binding order: u_in(0), h_prev(1), gates_out(2), weight(3), bias(4), gamma(5), params(6), output(7)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_in_buf      : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       h_prev_buf    : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       gates_out_buf : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read>       weight_buf    : array<vec4<f32>>;   // 9 vec4
@group(0) @binding(4) var<storage, read>       bias_buf      : array<vec4<f32>>;   // .x = cand_bias
@group(0) @binding(5) var<storage, read>       gamma_buf     : array<vec4<f32>>;   // .x = gamma
@group(0) @binding(6) var<uniform>             params        : Params;
@group(0) @binding(7) var<storage, read_write> output_buf    : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var cand_pre = bias_buf[0].x;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let idx  = u32(iy) * params.w + u32(ix);
            let b_n  = u_in_buf[idx].y;
            let h_n  = h_prev_buf[idx].z;
            let r_n  = gates_out_buf[idx].y;
            let w    = weight_buf[kpos].xy;
            cand_pre += w.x * b_n + w.y * (r_n * h_n);
        }
    }

    let h_til      = tanh(cand_pre);
    let cur        = y * params.w + x;
    let u_cur      = u_in_buf[cur];
    let z_cur      = gates_out_buf[cur].x;
    let h_prev_cur = h_prev_buf[cur].z;
    let h_new      = (1.0 - z_cur) * h_prev_cur + z_cur * h_til;
    let b_out      = u_cur.y + gamma_buf[0].x * h_new;
    output_buf[cur] = vec4<f32>(u_cur.x, b_out, h_new, 0.0);
}
\`;var xo=\`enable f16;

// cand_update_fused \\u2014 full f16 variant. See cand_update_fused.wgsl for details.
// ConvGRU candidate + state update + output (production config c_up=2, recurrent=1).
// Binding order: u_in(0), h_prev(1), gates_out(2), weight(3), bias(4), gamma(5), params(6), output(7)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_in_buf      : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       h_prev_buf    : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       gates_out_buf : array<vec4<f16>>;
@group(0) @binding(3) var<storage, read>       weight_buf    : array<vec4<f16>>;
@group(0) @binding(4) var<storage, read>       bias_buf      : array<vec4<f16>>;
@group(0) @binding(5) var<storage, read>       gamma_buf     : array<vec4<f16>>;
@group(0) @binding(6) var<uniform>             params        : Params;
@group(0) @binding(7) var<storage, read_write> output_buf    : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var cand_pre = bias_buf[0].x;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let idx  = u32(iy) * params.w + u32(ix);
            let b_n  = u_in_buf[idx].y;
            let h_n  = h_prev_buf[idx].z;
            let r_n  = gates_out_buf[idx].y;
            let w    = weight_buf[kpos].xy;
            cand_pre += w.x * b_n + w.y * (r_n * h_n);
        }
    }

    let h_til      = tanh(cand_pre);
    let cur        = y * params.w + x;
    let u_cur      = u_in_buf[cur];
    let z_cur      = gates_out_buf[cur].x;
    let h_prev_cur = h_prev_buf[cur].z;
    let h_new      = (1.0h - z_cur) * h_prev_cur + z_cur * h_til;
    let b_out      = u_cur.y + gamma_buf[0].x * h_new;
    output_buf[cur] = vec4<f16>(u_cur.x, b_out, h_new, 0.0h);
}
\`;var it=class extends h{constructor(r,t,a,o,n,s){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?xo:vo,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a,o],this.weights=[r.upload(m(n.weights)),r.upload(w(n.bias)),r.upload(w(s))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var yo=\`// conv_expand: bespoke N\\u21922 conv 3\\xD73 (pad 1) + relu (wrapper expand_feat).
// Expands feat_lr (in_c, mult of 4) to the c_up=2 carrier \\u2014 output .xy = the 2
// native channels, .zw = 0. mat4x2 per (kpos, in_group) with a vec2 accumulator.
// Weight: 9 * in_groups mat4x2 (8 floats each, col-major). Bias .xy.
// Binding order: input(0), weights(1), bias(2), params(3), output(4)

struct Params { h: u32, w: u32, in_groups: u32, _pad: u32 }

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x2<f32>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f32>>;   // .xy used
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var result = bias_buf[0].xy;
    let I = params.in_groups;

    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            for (var i = 0u; i < I; i++) {
                let in_idx = (u32(iy) * params.w + u32(ix)) * I + i;
                result += weight_buf[kpos * I + i] * input_buf[in_idx];
            }
        }
    }

    result = max(result, vec2<f32>(0.0));   // expand_feat is F.relu
    output_buf[y * params.w + x] = vec4<f32>(result, 0.0, 0.0);
}
\`;var wo=\`enable f16;

// conv_expand \\u2014 full f16 variant. See conv_expand.wgsl for layout details.
// Bespoke N\\u21922 conv 3\\xD73 (pad 1) + relu (wrapper expand_feat).
// Binding order: input(0), weights(1), bias(2), params(3), output(4)

struct Params { h: u32, w: u32, in_groups: u32, _pad: u32 }

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x2<f16>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var result = bias_buf[0].xy;
    let I = params.in_groups;

    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            for (var i = 0u; i < I; i++) {
                let in_idx = (u32(iy) * params.w + u32(ix)) * I + i;
                result += weight_buf[kpos * I + i] * input_buf[in_idx];
            }
        }
    }

    result = max(result, vec2<f16>(0.0h));
    output_buf[y * params.w + x] = vec4<f16>(result, 0.0h, 0.0h);
}
\`;var st=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?wo:yo;let o=t.c/4;this.output=r.tensor(t.h,t.w,4),this.inputs=[t],this.weights=[r.upload(m(a.weights)),r.upload(w(a.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,o,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var ko=\`// cat_conv_6to2: fused concat(u, d) + 6\\u21922 conv 3\\xD73 (pad 1) + relu (E up1_combine).
// u = c_up=2 carrier (.xy); d = c_high=4 (full vec4). Both same resolution.
// Channel order concat([u, d]) = (u.x, u.y, d.x, d.y, d.z, d.w), split into
//   v3a = (u.x, u.y, d.x)   v3b = d.yzw
// Weight: 9 * 2 mat3x2 (6 floats each, col-major). Bias .xy. Output c_up=2 carrier.
// Binding order: u(0), d(1), weights(2), bias(3), params(4), output(5)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_buf      : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       d_buf      : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat3x2<f32>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f32>>;   // .xy used
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var result = bias_buf[0].xy;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let pix = u32(iy) * params.w + u32(ix);
            let u = u_buf[pix];
            let d = d_buf[pix];
            let v3a = vec3<f32>(u.xy, d.x);
            let v3b = d.yzw;
            result += weight_buf[kpos * 2u + 0u] * v3a;
            result += weight_buf[kpos * 2u + 1u] * v3b;
        }
    }

    result = max(result, vec2<f32>(0.0));   // up1_combine is F.relu
    output_buf[y * params.w + x] = vec4<f32>(result, 0.0, 0.0);
}
\`;var To=\`enable f16;

// cat_conv_6to2 \\u2014 full f16 variant. See cat_conv_6to2.wgsl for layout details.
// Fused concat(u, d) + 6\\u21922 conv 3\\xD73 (pad 1) + relu (E up1_combine).
// Binding order: u(0), d(1), weights(2), bias(3), params(4), output(5)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_buf      : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       d_buf      : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<mat3x2<f16>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var result = bias_buf[0].xy;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let pix = u32(iy) * params.w + u32(ix);
            let u = u_buf[pix];
            let d = d_buf[pix];
            let v3a = vec3<f16>(u.xy, d.x);
            let v3b = d.yzw;
            result += weight_buf[kpos * 2u + 0u] * v3a;
            result += weight_buf[kpos * 2u + 1u] * v3b;
        }
    }

    result = max(result, vec2<f16>(0.0h));
    output_buf[y * params.w + x] = vec4<f16>(result, 0.0h, 0.0h);
}
\`;var nt=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?To:ko,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a],this.weights=[r.upload(m(o.weights)),r.upload(w(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var Po=\`// down_adapter: fused stride-N 3\\xD73 conv (4\\u21924) + relu + 1\\xD71 adapter (4\\u21923, no
// act) into one dispatch. E variant: down2 (c_high=4 \\u2192 c_low=4, stride 2) +
// adapter. A/B variant: down1 (RGB .xyz \\u2192 4, stride 2/3) + adapter (the down
// weight's 4th input column is zeroed at export for RGB input). Symmetric pad.
//
// down_w: 9 mat4x4 (3\\xD73, 4\\u21924). adapt_w: 1 mat4x4 (1\\xD71, 4\\u21924 padded from 4\\u21923,
// last row 0). adapt_b: .xyz used. Output: vec4(adapter.xyz, 0).
// Binding order: input(0), down_w(1), down_b(2), adapt_w(3), adapt_b(4), params(5), output(6)

struct Params {
    in_h     : u32,
    in_w     : u32,
    out_h    : u32,
    out_w    : u32,
    stride   : u32,
    pad_top  : u32,
    pad_left : u32,
    _pad     : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       down_w     : array<mat4x4<f32>>;   // 9 mat4x4
@group(0) @binding(2) var<storage, read>       down_b     : array<vec4<f32>>;     // 1 vec4
@group(0) @binding(3) var<storage, read>       adapt_w    : array<mat4x4<f32>>;   // 1 mat4x4
@group(0) @binding(4) var<storage, read>       adapt_b    : array<vec4<f32>>;     // .xyz used
@group(0) @binding(5) var<uniform>             p          : Params;
@group(0) @binding(6) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= p.out_w || y >= p.out_h) { return; }

    var down_out = down_b[0];
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y * p.stride + ky) - i32(p.pad_top);
            let ix = i32(x * p.stride + kx) - i32(p.pad_left);
            if (iy < 0 || ix < 0 || u32(iy) >= p.in_h || u32(ix) >= p.in_w) { continue; }
            let kpos = ky * 3u + kx;
            down_out += down_w[kpos] * input_buf[u32(iy) * p.in_w + u32(ix)];
        }
    }
    down_out = max(down_out, vec4<f32>(0.0));   // F.relu

    let adapt_out = adapt_w[0] * down_out + adapt_b[0];
    output_buf[y * p.out_w + x] = vec4<f32>(adapt_out.xyz, 0.0);
}
\`;var Co=\`enable f16;

// down_adapter \\u2014 full f16 variant. See down_adapter.wgsl for layout details.
// Fused stride-N 3\\xD73 conv (4\\u21924) + relu + 1\\xD71 adapter (4\\u21923, no act).
// Binding order: input(0), down_w(1), down_b(2), adapt_w(3), adapt_b(4), params(5), output(6)

struct Params {
    in_h     : u32,
    in_w     : u32,
    out_h    : u32,
    out_w    : u32,
    stride   : u32,
    pad_top  : u32,
    pad_left : u32,
    _pad     : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       down_w     : array<mat4x4<f16>>;
@group(0) @binding(2) var<storage, read>       down_b     : array<vec4<f16>>;
@group(0) @binding(3) var<storage, read>       adapt_w    : array<mat4x4<f16>>;
@group(0) @binding(4) var<storage, read>       adapt_b    : array<vec4<f16>>;
@group(0) @binding(5) var<uniform>             p          : Params;
@group(0) @binding(6) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= p.out_w || y >= p.out_h) { return; }

    var down_out = down_b[0];
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y * p.stride + ky) - i32(p.pad_top);
            let ix = i32(x * p.stride + kx) - i32(p.pad_left);
            if (iy < 0 || ix < 0 || u32(iy) >= p.in_h || u32(ix) >= p.in_w) { continue; }
            let kpos = ky * 3u + kx;
            down_out += down_w[kpos] * input_buf[u32(iy) * p.in_w + u32(ix)];
        }
    }
    down_out = max(down_out, vec4<f16>(0.0h));

    let adapt_out = adapt_w[0] * down_out + adapt_b[0];
    output_buf[y * p.out_w + x] = vec4<f16>(adapt_out.xyz, 0.0h);
}
\`;var ut=class extends h{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Co:Po;let s=C(t.h,3,n.stride,1),p=C(t.w,3,n.stride,1),c=G(1,t.h,s,3,n.stride),l=G(1,t.w,p,3,n.stride);this.output=r.tensor(s,p,4),this.inputs=[t],this.weights=[r.upload(m(a.weights)),r.upload(w(a.bias)),r.upload(m(o.weights)),r.upload(w(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,s,p,n.stride,c,l,0])),this.defaultSetup(),this.dispatch=[Math.ceil(p/8),Math.ceil(s/8),1]}};var Wo=\`// up_final: fused concat(u, rgb) \\u2192 conv 3\\xD73 5\\u21921 \\u2192 sigmoid (A/B alpha head).
// u = c_up=2 carrier (.xy); rgb = x_hr (.xyz). 5 inputs \\u2192 1 alpha (output .x).
// Weight: 18 vec4 \\u2014 [0..8] = (w0, w1, 0, 0) for u per kpos; [9..17] =
// (w2, w3, w4, 0) for rgb per kpos. Bias .x.
// Binding order: u(0), rgb(1), weights(2), bias(3), params(4), output(5)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_gru      : array<vec4<f32>>;   // .xy
@group(0) @binding(1) var<storage, read>       rgb        : array<vec4<f32>>;   // .xyz
@group(0) @binding(2) var<storage, read>       weight_buf : array<vec4<f32>>;   // 18 vec4
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f32>>;   // .x
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f32>>;   // .x = alpha

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var acc = bias_buf[0].x;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let p = u32(iy) * params.w + u32(ix);
            acc += dot(weight_buf[kpos].xy,       u_gru[p].xy);
            acc += dot(weight_buf[9u + kpos].xyz, rgb[p].xyz);
        }
    }

    output_buf[y * params.w + x] = vec4<f32>(1.0 / (1.0 + exp(-acc)), 0.0, 0.0, 0.0);
}
\`;var Go=\`enable f16;

// up_final \\u2014 full f16 variant. See up_final.wgsl for layout details.
// Fused concat(u, rgb) \\u2192 conv 3\\xD73 5\\u21921 \\u2192 sigmoid (A/B alpha head).
// Binding order: u(0), rgb(1), weights(2), bias(3), params(4), output(5)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_gru      : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       rgb        : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       weight_buf : array<vec4<f16>>;
@group(0) @binding(3) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(4) var<uniform>             params     : Params;
@group(0) @binding(5) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var acc = bias_buf[0].x;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let p = u32(iy) * params.w + u32(ix);
            acc += dot(weight_buf[kpos].xy,       u_gru[p].xy);
            acc += dot(weight_buf[9u + kpos].xyz, rgb[p].xyz);
        }
    }

    output_buf[y * params.w + x] = vec4<f16>(1.0h / (1.0h + exp(-acc)), 0.0h, 0.0h, 0.0h);
}
\`;var pt=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Go:Wo,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a],this.weights=[r.upload(m(o.weights)),r.upload(w(o.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var Uo=\`// up_final_skip: C/D alpha head. Fused concat(u, d_full, rgb) \\u2192 conv 3\\xD73 9\\u21921
// \\u2192 sigmoid. u = c_up=2 (.xy); d_full = c_high=4 full-res skip (full vec4);
// rgb = x_hr (.xyz). Channel order concat = 2 + 4 + 3 = 9. Output .x = alpha.
// Weight: 27 vec4 (3 per kpos): [kpos*3+0]=(w0,w1,0,0) u; [kpos*3+1]=(w2..w5)
// d_full; [kpos*3+2]=(w6,w7,w8,0) rgb. Bias .x.
// Binding order: u(0), d_full(1), rgb(2), weights(3), bias(4), params(5), output(6)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_gru      : array<vec4<f32>>;   // .xy
@group(0) @binding(1) var<storage, read>       d_full     : array<vec4<f32>>;   // full vec4
@group(0) @binding(2) var<storage, read>       rgb        : array<vec4<f32>>;   // .xyz
@group(0) @binding(3) var<storage, read>       weight_buf : array<vec4<f32>>;   // 27 vec4
@group(0) @binding(4) var<storage, read>       bias_buf   : array<vec4<f32>>;   // .x
@group(0) @binding(5) var<uniform>             params     : Params;
@group(0) @binding(6) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var acc = bias_buf[0].x;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let p = u32(iy) * params.w + u32(ix);
            acc += dot(weight_buf[kpos * 3u + 0u].xy,  u_gru[p].xy);
            acc += dot(weight_buf[kpos * 3u + 1u],     d_full[p]);
            acc += dot(weight_buf[kpos * 3u + 2u].xyz, rgb[p].xyz);
        }
    }

    output_buf[y * params.w + x] = vec4<f32>(1.0 / (1.0 + exp(-acc)), 0.0, 0.0, 0.0);
}
\`;var Bo=\`enable f16;

// up_final_skip \\u2014 full f16 variant. See up_final_skip.wgsl for layout details.
// C/D alpha head: fused concat(u, d_full, rgb) \\u2192 conv 3\\xD73 9\\u21921 \\u2192 sigmoid.
// Binding order: u(0), d_full(1), rgb(2), weights(3), bias(4), params(5), output(6)

struct Params { h: u32, w: u32, _pad0: u32, _pad1: u32 }

@group(0) @binding(0) var<storage, read>       u_gru      : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       d_full     : array<vec4<f16>>;
@group(0) @binding(2) var<storage, read>       rgb        : array<vec4<f16>>;
@group(0) @binding(3) var<storage, read>       weight_buf : array<vec4<f16>>;
@group(0) @binding(4) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(5) var<uniform>             params     : Params;
@group(0) @binding(6) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x; let y = gid.y;
    if (x >= params.w || y >= params.h) { return; }

    var acc = bias_buf[0].x;
    for (var ky = 0u; ky < 3u; ky++) {
        for (var kx = 0u; kx < 3u; kx++) {
            let iy = i32(y + ky) - 1; let ix = i32(x + kx) - 1;
            if (iy < 0 || ix < 0 || u32(iy) >= params.h || u32(ix) >= params.w) { continue; }
            let kpos = ky * 3u + kx;
            let p = u32(iy) * params.w + u32(ix);
            acc += dot(weight_buf[kpos * 3u + 0u].xy,  u_gru[p].xy);
            acc += dot(weight_buf[kpos * 3u + 1u],     d_full[p]);
            acc += dot(weight_buf[kpos * 3u + 2u].xyz, rgb[p].xyz);
        }
    }

    output_buf[y * params.w + x] = vec4<f16>(1.0h / (1.0h + exp(-acc)), 0.0h, 0.0h, 0.0h);
}
\`;var ct=class extends h{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Bo:Uo,this.output=r.tensor(t.h,t.w,4),this.inputs=[t,a,o],this.weights=[r.upload(m(n.weights)),r.upload(w(n.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(t.w/8),Math.ceil(t.h/8),1]}};var So=\`// Bilinear upsample + channel concat fused.
// input_a is the decoder tensor at small spatial resolution (in_h \\xD7 in_w).
// input_b is the encoder skip feature already at output resolution (out_h \\xD7 out_w).
// For output channels 0..a_groups-1: bilinearly interpolate from input_a.
// For output channels a_groups..out_groups-1: copy directly from input_b.
// Eliminates the intermediate upsample buffer and the separate concat dispatch.

struct Params {
    in_h       : u32,   // input_a spatial height
    in_w       : u32,   // input_a spatial width
    out_h      : u32,
    out_w      : u32,
    a_groups   : u32,   // input_a channel groups (upsampled)
    b_groups   : u32,   // input_b channel groups (encoder feature)
    out_groups : u32,   // a_groups + b_groups
    _pad0      : u32,
}

@group(0) @binding(0) var<storage, read>       input_a    : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       input_b    : array<vec4<f32>>;
@group(0) @binding(2) var<uniform>             params     : Params;
@group(0) @binding(3) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.out_groups) { return; }

    let out_idx = oy * params.out_w * params.out_groups + ox * params.out_groups + c;

    if (c < params.a_groups) {
        let IH = params.in_h;
        let IW = params.in_w;
        let AG = params.a_groups;

        let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
        let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

        let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
        let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
        let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
        let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

        let wx = src_x - floor(src_x);
        let wy = src_y - floor(src_y);

        let tl = input_a[y0 * IW * AG + x0 * AG + c];
        let tr = input_a[y0 * IW * AG + x1 * AG + c];
        let bl = input_a[y1 * IW * AG + x0 * AG + c];
        let br = input_a[y1 * IW * AG + x1 * AG + c];

        output_buf[out_idx] = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
                            +        wy  * ((1.0 - wx) * bl + wx * br);
    } else {
        let c_b = c - params.a_groups;
        output_buf[out_idx] = input_b[oy * params.out_w * params.b_groups + ox * params.b_groups + c_b];
    }
}
\`;var Ao=\`enable f16;

// Bilinear upsample + channel concat fused \\u2014 full f16 variant.
// Bilinear weights (wx, wy) and intermediate blends computed in f32; result cast to f16.

struct Params {
    in_h       : u32,
    in_w       : u32,
    out_h      : u32,
    out_w      : u32,
    a_groups   : u32,
    b_groups   : u32,
    out_groups : u32,
    _pad0      : u32,
}

@group(0) @binding(0) var<storage, read>       input_a    : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       input_b    : array<vec4<f16>>;
@group(0) @binding(2) var<uniform>             params     : Params;
@group(0) @binding(3) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.out_groups) { return; }

    let out_idx = oy * params.out_w * params.out_groups + ox * params.out_groups + c;

    if (c < params.a_groups) {
        let IH = params.in_h;
        let IW = params.in_w;
        let AG = params.a_groups;

        let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
        let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

        let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
        let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
        let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
        let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

        let wx = src_x - floor(src_x);
        let wy = src_y - floor(src_y);

        let tl = vec4<f32>(input_a[y0 * IW * AG + x0 * AG + c]);
        let tr = vec4<f32>(input_a[y0 * IW * AG + x1 * AG + c]);
        let bl = vec4<f32>(input_a[y1 * IW * AG + x0 * AG + c]);
        let br = vec4<f32>(input_a[y1 * IW * AG + x1 * AG + c]);

        let result = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
                   +        wy  * ((1.0 - wx) * bl + wx * br);
        output_buf[out_idx] = vec4<f16>(result);
    } else {
        let c_b = c - params.a_groups;
        output_buf[out_idx] = input_b[oy * params.out_w * params.b_groups + ox * params.b_groups + c_b];
    }
}
\`;var lt=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Ao:So;let n=t.c/4,s=a.c/4,p=n+s;this.output=r.tensor(o.outH,o.outW,t.c+a.c),this.inputs=[t,a],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,o.outH,o.outW,n,s,p,0])),this.defaultSetup(),this.dispatch=[Math.ceil(o.outW/8),Math.ceil(o.outH/8),p]}};var Lo=\`// Bilinear upsample + 1\\xD71 pointwise conv fused.
// For each output pixel, bilinearly samples the small input for each in_group,
// immediately applies the 1\\xD71 conv weights, and writes the activated result.
// Eliminates the intermediate full-resolution upsample buffer.

struct Params {
    in_h       : u32,
    in_w       : u32,
    out_h      : u32,
    out_w      : u32,
    in_groups  : u32,
    out_groups : u32,
    activation : u32,
    _pad0      : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x4<f32>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f32>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let og = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || og >= params.out_groups) { return; }

    let IH = params.in_h;
    let IW = params.in_w;
    let IG = params.in_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    var result = bias_buf[og];

    for (var ig = 0u; ig < IG; ig++) {
        let tl = input_buf[y0 * IW * IG + x0 * IG + ig];
        let tr = input_buf[y0 * IW * IG + x1 * IG + ig];
        let bl = input_buf[y1 * IW * IG + x0 * IG + ig];
        let br = input_buf[y1 * IW * IG + x1 * IG + ig];

        let sampled = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
                    +        wy  * ((1.0 - wx) * bl + wx * br);

        result += weight_buf[og * IG + ig] * sampled;
    }

    if (params.activation == 1u) {
        result = clamp(result, vec4<f32>(0.0), vec4<f32>(6.0));
    } else if (params.activation == 2u) {
        result = result * clamp(result + 3.0, vec4<f32>(0.0), vec4<f32>(6.0)) / 6.0;
    }

    output_buf[oy * params.out_w * params.out_groups + ox * params.out_groups + og] = result;
}
\`;var Fo=\`enable f16;

// Bilinear upsample + 1\\xD71 pointwise conv fused \\u2014 full f16 variant.
// Bilinear weights and intermediate blends computed in f32; conv accumulation in f16.

struct Params {
    in_h       : u32,
    in_w       : u32,
    out_h      : u32,
    out_w      : u32,
    in_groups  : u32,
    out_groups : u32,
    activation : u32,
    _pad0      : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<storage, read>       weight_buf : array<mat4x4<f16>>;
@group(0) @binding(2) var<storage, read>       bias_buf   : array<vec4<f16>>;
@group(0) @binding(3) var<uniform>             params     : Params;
@group(0) @binding(4) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let og = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || og >= params.out_groups) { return; }

    let IH = params.in_h;
    let IW = params.in_w;
    let IG = params.in_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    var result = bias_buf[og];

    for (var ig = 0u; ig < IG; ig++) {
        let tl = vec4<f32>(input_buf[y0 * IW * IG + x0 * IG + ig]);
        let tr = vec4<f32>(input_buf[y0 * IW * IG + x1 * IG + ig]);
        let bl = vec4<f32>(input_buf[y1 * IW * IG + x0 * IG + ig]);
        let br = vec4<f32>(input_buf[y1 * IW * IG + x1 * IG + ig]);

        let sampled = vec4<f16>((1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
                              +        wy  * ((1.0 - wx) * bl + wx * br));

        result += weight_buf[og * IG + ig] * sampled;
    }

    if (params.activation == 1u) {
        result = clamp(result, vec4<f16>(0.0h), vec4<f16>(6.0h));
    } else if (params.activation == 2u) {
        result = result * clamp(result + 3.0h, vec4<f16>(0.0h), vec4<f16>(6.0h)) / 6.0h;
    }

    output_buf[oy * params.out_w * params.out_groups + ox * params.out_groups + og] = result;
}
\`;var ft=class extends h{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Fo:Lo;let n=t.c/4,s=o.outChannels/4;this.output=r.tensor(o.outH,o.outW,o.outChannels),this.inputs=[t],this.weights=[r.upload(m(a.weights)),r.upload(m(a.bias))],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,o.outH,o.outW,n,s,o.activation==="relu6"?1:0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(o.outW/8),Math.ceil(o.outH/8),s]}};var Eo=\`// Bilinear upsample + sigmoid fused.
// Identical to bilinear_upsample.wgsl except sigmoid is applied at write time.
// Eliminates the intermediate full-resolution buffer and the separate sigmoid dispatch.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    _pad0          : u32,
    _pad1          : u32,
    _pad2          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let IH = params.in_h;
    let IW = params.in_w;
    let C  = params.channel_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    let tl = input_buf[y0 * IW * C + x0 * C + c];
    let tr = input_buf[y0 * IW * C + x1 * C + c];
    let bl = input_buf[y1 * IW * C + x0 * C + c];
    let br = input_buf[y1 * IW * C + x1 * C + c];

    let result = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
               +        wy  * ((1.0 - wx) * bl + wx * br);

    output_buf[oy * params.out_w * C + ox * C + c] = 1.0 / (1.0 + exp(-result));
}
\`;var Ro=\`enable f16;

// Bilinear upsample + sigmoid fused \\u2014 full f16 variant.
// Interpolation computed in f32 for accuracy; sigmoid and result cast to f16.

struct Params {
    in_h           : u32,
    in_w           : u32,
    out_h          : u32,
    out_w          : u32,
    channel_groups : u32,
    _pad0          : u32,
    _pad1          : u32,
    _pad2          : u32,
}

@group(0) @binding(0) var<storage, read>       input_buf  : array<vec4<f16>>;
@group(0) @binding(1) var<uniform>             params     : Params;
@group(0) @binding(2) var<storage, read_write> output_buf : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let ox = gid.x;
    let oy = gid.y;
    let c  = gid.z;

    if (ox >= params.out_w || oy >= params.out_h || c >= params.channel_groups) {
        return;
    }

    let IH = params.in_h;
    let IW = params.in_w;
    let C  = params.channel_groups;

    let src_x = (f32(ox) + 0.5) * (f32(IW) / f32(params.out_w)) - 0.5;
    let src_y = (f32(oy) + 0.5) * (f32(IH) / f32(params.out_h)) - 0.5;

    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(IW) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(IW) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(IH) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(IH) - 1));

    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    let tl = vec4<f32>(input_buf[y0 * IW * C + x0 * C + c]);
    let tr = vec4<f32>(input_buf[y0 * IW * C + x1 * C + c]);
    let bl = vec4<f32>(input_buf[y1 * IW * C + x0 * C + c]);
    let br = vec4<f32>(input_buf[y1 * IW * C + x1 * C + c]);

    let result = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
               +        wy  * ((1.0 - wx) * bl + wx * br);

    output_buf[oy * params.out_w * C + ox * C + c] = vec4<f16>(1.0 / (1.0 + exp(-result)));
}
\`;var dt=class extends h{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader");this.shader=r.dtype==="f16"?Ro:Eo;let o=t.c/4;this.output=r.tensor(a.outH,a.outW,t.c),this.inputs=[t],this.createUniform("params","Params"),this.setUniform("params",new Uint32Array([t.h,t.w,a.outH,a.outW,o,0,0,0])),this.defaultSetup(),this.dispatch=[Math.ceil(a.outW/8),Math.ceil(a.outH/8),o]}};var Do=\`// Composite an RGBA image over a solid background, gated by a 1-ch alpha.
// Fragment writes the canvas's swapchain texture (premultiplied output).
//
// Caller invariants (matched in CompositeSolidWebGPU):
//   - image and alpha are NHWC vec4 storage buffers, same h \\xD7 w
//   - canvas.width === image.w, canvas.height === image.h (no resampling)

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    width:    u32,           // image width in pixels (= canvas width)
    _pad0:    u32,
    _pad1:    u32,
    _pad2:    u32,
    bgColor:  vec4<f32>,     // .rgb used; .a ignored
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> alpha:  array<vec4<f32>>;
@group(0) @binding(2) var<uniform>       params: Params;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.width + x;

    let fg = image[i].rgb;
    let a  = alpha[i].r;
    let rgb = fg * a + params.bgColor.rgb * (1.0 - a);
    return vec4<f32>(rgb, 1.0);
}
\`;var Oo=\`enable f16;

// Composite an RGBA image over a solid background, gated by a 1-ch alpha.
// f16 variant: image and alpha are stored as f16; values promote to f32 on
// read and the fragment writes f32 to the canvas swapchain (color attachment
// format is the swapchain's preferred format, always f32-equivalent).
//
// Caller invariants (matched in CompositeSolidWebGPU):
//   - image and alpha are NHWC vec4 storage buffers, same h \\xD7 w
//   - canvas.width === image.w, canvas.height === image.h (no resampling)

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    width:    u32,
    _pad0:    u32,
    _pad1:    u32,
    _pad2:    u32,
    bgColor:  vec4<f32>,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f16>>;
@group(0) @binding(1) var<storage, read> alpha:  array<vec4<f16>>;
@group(0) @binding(2) var<uniform>       params: Params;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.width + x;

    let fg = vec3<f32>(image[i].rgb);
    let a  = f32(alpha[i].r);
    let rgb = fg * a + params.bgColor.rgb * (1.0 - a);
    return vec4<f32>(rgb, 1.0);
}
\`;var mt=class{constructor(e,r,t,a){i(this,"backend",e);i(this,"pipeline");i(this,"bindGroup");i(this,"uniformBuffer");i(this,"outputView",null);if(r.h!==t.h||r.w!==t.w)throw new Error(\`CompositeSolid: image (\${r.h}\\xD7\${r.w}) and alpha (\${t.h}\\xD7\${t.w}) must match. Run the upscaler first.\`);let o=e.device;this.uniformBuffer=o.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let n=new ArrayBuffer(32);new Uint32Array(n,0,1)[0]=r.w,new Float32Array(n,16,4).set([a[0],a[1],a[2],0]),o.queue.writeBuffer(this.uniformBuffer,0,n);let s=e.dtype==="f16"?Oo:Do,p=o.createShaderModule({code:s});this.pipeline=o.createRenderPipeline({layout:"auto",vertex:{module:p,entryPoint:"vs"},fragment:{module:p,entryPoint:"fs",targets:[{format:e.canvasFormat}]},primitive:{topology:"triangle-list"}}),this.bindGroup=o.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.buffer}},{binding:1,resource:{buffer:t.buffer}},{binding:2,resource:{buffer:this.uniformBuffer}}]})}setOutput(e){this.outputView=e.createView()}run(){if(!this.outputView)throw new Error("CompositeSolidWebGPU.run() called before setOutput()");let e=this.backend.device.createCommandEncoder(),r=e.beginRenderPass({colorAttachments:[{view:this.outputView,clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});r.setPipeline(this.pipeline),r.setBindGroup(0,this.bindGroup),r.draw(6),r.end(),this.backend.device.queue.submit([e.finish()]),this.outputView=null}};var Io=\`// Like composite_solid but bg is an NHWC vec4 storage buffer (e.g. virtual
// background image, or a blurred copy of the input).

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    width: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> alpha:  array<vec4<f32>>;
@group(0) @binding(2) var<uniform>       params: Params;
@group(0) @binding(3) var<storage, read> bg:     array<vec4<f32>>;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.width + x;

    let fg  = image[i].rgb;
    let a   = alpha[i].r;
    let bgc = bg[i].rgb;
    let rgb = fg * a + bgc * (1.0 - a);
    return vec4<f32>(rgb, 1.0);
}
\`;var Mo=\`enable f16;

// Like composite_solid_f16 but bg is an NHWC vec4<f16> storage buffer (e.g. a
// virtual background image, or a blurred copy of the input).

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    width: u32,
    _pad0: u32,
    _pad1: u32,
    _pad2: u32,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f16>>;
@group(0) @binding(1) var<storage, read> alpha:  array<vec4<f16>>;
@group(0) @binding(2) var<uniform>       params: Params;
@group(0) @binding(3) var<storage, read> bg:     array<vec4<f16>>;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.width + x;

    let fg  = vec3<f32>(image[i].rgb);
    let a   = f32(alpha[i].r);
    let bgc = vec3<f32>(bg[i].rgb);
    let rgb = fg * a + bgc * (1.0 - a);
    return vec4<f32>(rgb, 1.0);
}
\`;var ht=class{constructor(e,r,t,a){i(this,"backend",e);i(this,"pipeline");i(this,"bindGroup");i(this,"uniformBuffer");i(this,"outputView",null);if(r.h!==t.h||r.w!==t.w||r.h!==a.h||r.w!==a.w)throw new Error(\`CompositeImage: image (\${r.h}\\xD7\${r.w}), alpha (\${t.h}\\xD7\${t.w}), and bg (\${a.h}\\xD7\${a.w}) must all match. Run upscaler / resizer first.\`);let o=e.device;this.uniformBuffer=o.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let n=new ArrayBuffer(16);new Uint32Array(n,0,1)[0]=r.w,o.queue.writeBuffer(this.uniformBuffer,0,n);let s=e.dtype==="f16"?Mo:Io,p=o.createShaderModule({code:s});this.pipeline=o.createRenderPipeline({layout:"auto",vertex:{module:p,entryPoint:"vs"},fragment:{module:p,entryPoint:"fs",targets:[{format:e.canvasFormat}]},primitive:{topology:"triangle-list"}}),this.bindGroup=o.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.buffer}},{binding:1,resource:{buffer:t.buffer}},{binding:2,resource:{buffer:this.uniformBuffer}},{binding:3,resource:{buffer:a.buffer}}]})}setOutput(e){this.outputView=e.createView()}run(){if(!this.outputView)throw new Error("CompositeImageWebGPU.run() called before setOutput()");let e=this.backend.device.createCommandEncoder(),r=e.beginRenderPass({colorAttachments:[{view:this.outputView,clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});r.setPipeline(this.pipeline),r.setBindGroup(0,this.bindGroup),r.draw(6),r.end(),this.backend.device.queue.submit([e.finish()]),this.outputView=null}};var zo=\`// Like composite_image but bg is sampled bilinearly \\u2014 bg may be smaller than
// (image, alpha). Used by CompositorBlur to skip the final full-res upsample
// in the blur pyramid and let this shader's own per-pixel scan do the
// expansion (the work is already happening here for the composite anyway).
//
// Layout invariant: image, alpha share output dims (canvas h \\xD7 w); bg is
// at a smaller resolution (bg_h \\xD7 bg_w). All NHWC vec4 storage buffers,
// channelGroups = 1 (RGB padded to vec4).

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    out_w: u32,
    out_h: u32,
    bg_w:  u32,
    bg_h:  u32,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> alpha:  array<vec4<f32>>;
@group(0) @binding(2) var<uniform>       params: Params;
@group(0) @binding(3) var<storage, read> bg:     array<vec4<f32>>;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.out_w + x;

    let fg = image[i].rgb;
    let a  = alpha[i].r;

    // Bilinear sample bg at the corresponding location. align_corners=False.
    let src_x = (f32(x) + 0.5) * (f32(params.bg_w) / f32(params.out_w)) - 0.5;
    let src_y = (f32(y) + 0.5) * (f32(params.bg_h) / f32(params.out_h)) - 0.5;
    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(params.bg_w) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(params.bg_w) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(params.bg_h) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(params.bg_h) - 1));
    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    let tl = bg[y0 * params.bg_w + x0].rgb;
    let tr = bg[y0 * params.bg_w + x1].rgb;
    let bl = bg[y1 * params.bg_w + x0].rgb;
    let br = bg[y1 * params.bg_w + x1].rgb;
    let bgc = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
            +        wy  * ((1.0 - wx) * bl + wx * br);

    let rgb = fg * a + bgc * (1.0 - a);
    return vec4<f32>(rgb, 1.0);
}
\`;var Ho=\`enable f16;

// f16 storage variant of composite_image_bilinear. bg is at a smaller
// resolution and is bilinearly sampled to match (image, alpha) at full res.
// Computation in f32; storage in f16.

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    out_w: u32,
    out_h: u32,
    bg_w:  u32,
    bg_h:  u32,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f16>>;
@group(0) @binding(1) var<storage, read> alpha:  array<vec4<f16>>;
@group(0) @binding(2) var<uniform>       params: Params;
@group(0) @binding(3) var<storage, read> bg:     array<vec4<f16>>;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.out_w + x;

    let fg = vec3<f32>(image[i].rgb);
    let a  = f32(alpha[i].r);

    let src_x = (f32(x) + 0.5) * (f32(params.bg_w) / f32(params.out_w)) - 0.5;
    let src_y = (f32(y) + 0.5) * (f32(params.bg_h) / f32(params.out_h)) - 0.5;
    let x0 = u32(clamp(i32(floor(src_x)),     0, i32(params.bg_w) - 1));
    let x1 = u32(clamp(i32(floor(src_x)) + 1, 0, i32(params.bg_w) - 1));
    let y0 = u32(clamp(i32(floor(src_y)),     0, i32(params.bg_h) - 1));
    let y1 = u32(clamp(i32(floor(src_y)) + 1, 0, i32(params.bg_h) - 1));
    let wx = src_x - floor(src_x);
    let wy = src_y - floor(src_y);

    let tl = vec3<f32>(bg[y0 * params.bg_w + x0].rgb);
    let tr = vec3<f32>(bg[y0 * params.bg_w + x1].rgb);
    let bl = vec3<f32>(bg[y1 * params.bg_w + x0].rgb);
    let br = vec3<f32>(bg[y1 * params.bg_w + x1].rgb);
    let bgc = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
            +        wy  * ((1.0 - wx) * bl + wx * br);

    let rgb = fg * a + bgc * (1.0 - a);
    return vec4<f32>(rgb, 1.0);
}
\`;var gt=class{constructor(e,r,t,a){i(this,"backend",e);i(this,"pipeline");i(this,"bindGroup");i(this,"uniformBuffer");i(this,"outputView",null);if(r.h!==t.h||r.w!==t.w)throw new Error(\`CompositeImageBilinear: image (\${r.h}\\xD7\${r.w}) and alpha (\${t.h}\\xD7\${t.w}) must match.\`);let o=e.device;this.uniformBuffer=o.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let n=new ArrayBuffer(16),s=new Uint32Array(n);s[0]=r.w,s[1]=r.h,s[2]=a.w,s[3]=a.h,o.queue.writeBuffer(this.uniformBuffer,0,n);let p=e.dtype==="f16"?Ho:zo,c=o.createShaderModule({code:p});this.pipeline=o.createRenderPipeline({layout:"auto",vertex:{module:c,entryPoint:"vs"},fragment:{module:c,entryPoint:"fs",targets:[{format:e.canvasFormat}]},primitive:{topology:"triangle-list"}}),this.bindGroup=o.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.buffer}},{binding:1,resource:{buffer:t.buffer}},{binding:2,resource:{buffer:this.uniformBuffer}},{binding:3,resource:{buffer:a.buffer}}]})}setOutput(e){this.outputView=e.createView()}run(){if(!this.outputView)throw new Error("CompositeImageBilinearWebGPU.run() called before setOutput()");let e=this.backend.device.createCommandEncoder(),r=e.beginRenderPass({colorAttachments:[{view:this.outputView,clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});r.setPipeline(this.pipeline),r.setBindGroup(0,this.bindGroup),r.draw(6),r.end(),this.backend.device.queue.submit([e.finish()]),this.outputView=null}};var No=\`// Passthrough "compositor" \\u2014 writes the image directly to the canvas
// swapchain texture with no alpha math and no background. Used by RenderOp
// when the renderer is in disabled state, so the output canvas reflects
// the unmodified input frame instead of a stale matted result.
//
// Caller invariants (matched in CompositePassthroughWebGPU):
//   - image is an NHWC vec4 storage buffer
//   - canvas.width === image.w, canvas.height === image.h (no resampling)

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    width: u32,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f32>>;
@group(0) @binding(1) var<uniform>       params: Params;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.width + x;
    return vec4<f32>(image[i].rgb, 1.0);
}
\`;var Vo=\`enable f16;

// Passthrough "compositor" \\u2014 f16 variant. Image is stored as f16; values
// promote to f32 on read and the fragment writes f32 to the canvas
// swapchain (color attachment is the swapchain's preferred f32-equivalent
// format). See composite_passthrough.wgsl for the f32 version.

struct VertexOut {
    @builtin(position) pos: vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VertexOut {
    let verts = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
        vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
    );
    var out: VertexOut;
    out.pos = vec4<f32>(verts[vi], 0.0, 1.0);
    return out;
}

struct Params {
    width: u32,
};

@group(0) @binding(0) var<storage, read> image:  array<vec4<f16>>;
@group(0) @binding(1) var<uniform>       params: Params;

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
    let x = u32(in.pos.x);
    let y = u32(in.pos.y);
    let i = y * params.width + x;
    return vec4<f32>(vec3<f32>(image[i].rgb), 1.0);
}
\`;var _t=class{constructor(e,r){i(this,"backend",e);i(this,"pipeline");i(this,"bindGroup");i(this,"uniformBuffer");i(this,"outputView",null);let t=e.device;this.uniformBuffer=t.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let a=new ArrayBuffer(16);new Uint32Array(a,0,1)[0]=r.w,t.queue.writeBuffer(this.uniformBuffer,0,a);let o=e.dtype==="f16"?Vo:No,n=t.createShaderModule({code:o});this.pipeline=t.createRenderPipeline({layout:"auto",vertex:{module:n,entryPoint:"vs"},fragment:{module:n,entryPoint:"fs",targets:[{format:e.canvasFormat}]},primitive:{topology:"triangle-list"}}),this.bindGroup=t.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.buffer}},{binding:1,resource:{buffer:this.uniformBuffer}}]})}setOutput(e){this.outputView=e.createView()}run(){if(!this.outputView)throw new Error("CompositePassthroughWebGPU.run() called before setOutput()");let e=this.backend.device.createCommandEncoder(),r=e.beginRenderPass({colorAttachments:[{view:this.outputView,clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});r.setPipeline(this.pipeline),r.setBindGroup(0,this.bindGroup),r.draw(6),r.end(),this.backend.device.queue.submit([e.finish()]),this.outputView=null}};var Xo=\`// Input op \\u2014 sample a regular 2D source texture (RGBA8 unorm) into the NHWC
// vec4<f32> output buffer at the target resolution. Used for ImageBitmap
// sources, which are uploaded into a persistent staging texture via
// copyExternalImageToTexture before each dispatch.

struct Params {
    out_w : u32,
    out_h : u32,
    _pad0 : u32,
    _pad1 : u32,
}

@group(0) @binding(0) var                       src_tex     : texture_2d<f32>;
@group(0) @binding(1) var                       src_sampler : sampler;
@group(0) @binding(2) var<uniform>              params      : Params;
@group(0) @binding(3) var<storage, read_write>  output_buf  : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.out_w || y >= params.out_h) { return; }

    let uv = vec2<f32>(
        (f32(x) + 0.5) / f32(params.out_w),
        (f32(y) + 0.5) / f32(params.out_h),
    );
    let rgba = textureSampleLevel(src_tex, src_sampler, uv, 0.0);
    output_buf[y * params.out_w + x] = rgba;
}
\`;var jo=\`enable f16;

// Input op \\u2014 f16 storage variant. Source is sampled as vec4<f32>; only the
// store is demoted to vec4<f16>.

struct Params {
    out_w : u32,
    out_h : u32,
    _pad0 : u32,
    _pad1 : u32,
}

@group(0) @binding(0) var                       src_tex     : texture_2d<f32>;
@group(0) @binding(1) var                       src_sampler : sampler;
@group(0) @binding(2) var<uniform>              params      : Params;
@group(0) @binding(3) var<storage, read_write>  output_buf  : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.out_w || y >= params.out_h) { return; }

    let uv = vec2<f32>(
        (f32(x) + 0.5) / f32(params.out_w),
        (f32(y) + 0.5) / f32(params.out_h),
    );
    let rgba = textureSampleLevel(src_tex, src_sampler, uv, 0.0);
    output_buf[y * params.out_w + x] = vec4<f16>(rgba);
}
\`;var qo=\`// Input op \\u2014 sample a GPUExternalTexture (zero-copy VideoFrame import) into
// the NHWC vec4<f32> output buffer at the target resolution. Used when the
// caller passes a VideoFrame to setSource(); requires importExternalTexture
// to be called in the same task as the dispatch (the texture is invalidated
// after the current task completes).

struct Params {
    out_w : u32,
    out_h : u32,
    _pad0 : u32,
    _pad1 : u32,
}

@group(0) @binding(0) var                       src_tex     : texture_external;
@group(0) @binding(1) var                       src_sampler : sampler;
@group(0) @binding(2) var<uniform>              params      : Params;
@group(0) @binding(3) var<storage, read_write>  output_buf  : array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.out_w || y >= params.out_h) { return; }

    let uv = vec2<f32>(
        (f32(x) + 0.5) / f32(params.out_w),
        (f32(y) + 0.5) / f32(params.out_h),
    );
    let rgba = textureSampleBaseClampToEdge(src_tex, src_sampler, uv);
    output_buf[y * params.out_w + x] = rgba;
}
\`;var $o=\`enable f16;

// Input op \\u2014 texture_external + f16 storage. Sample in f32, store as f16.

struct Params {
    out_w : u32,
    out_h : u32,
    _pad0 : u32,
    _pad1 : u32,
}

@group(0) @binding(0) var                       src_tex     : texture_external;
@group(0) @binding(1) var                       src_sampler : sampler;
@group(0) @binding(2) var<uniform>              params      : Params;
@group(0) @binding(3) var<storage, read_write>  output_buf  : array<vec4<f16>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let x = gid.x;
    let y = gid.y;
    if (x >= params.out_w || y >= params.out_h) { return; }

    let uv = vec2<f32>(
        (f32(x) + 0.5) / f32(params.out_w),
        (f32(y) + 0.5) / f32(params.out_h),
    );
    let rgba = textureSampleBaseClampToEdge(src_tex, src_sampler, uv);
    output_buf[y * params.out_w + x] = vec4<f16>(rgba);
}
\`;var Js=u=>typeof VideoFrame<"u"&&u instanceof VideoFrame,bt=class{constructor(e,r,t){i(this,"output");i(this,"device");i(this,"dtype");i(this,"sampler");i(this,"uniformBuffer");i(this,"dispatch");i(this,"pipeline2d",null);i(this,"pipelineExternal",null);i(this,"stagingTex",null);i(this,"stagingW",0);i(this,"stagingH",0);i(this,"source",null);this.device=e.device,this.dtype=e.dtype,this.output=e.tensor(r,t,4),this.sampler=this.device.createSampler({magFilter:"linear",minFilter:"linear",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"}),this.uniformBuffer=this.device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let a=new ArrayBuffer(16);new Uint32Array(a,0,2).set([t,r]),this.device.queue.writeBuffer(this.uniformBuffer,0,a),this.dispatch=[Math.ceil(t/8),Math.ceil(r/8),1],this.pipeline2d=this.buildPipeline(this.dtype==="f16"?jo:Xo)}setSource(e){this.source=e}run(){if(!this.source)throw new Error("InputWebGPU.run() called before setSource()");Js(this.source)?this.runExternal(this.source):this.run2d(this.source)}run2d(e){this.ensureStagingTexture(e.width,e.height),this.device.queue.copyExternalImageToTexture({source:e,flipY:!1},{texture:this.stagingTex},[e.width,e.height]);let r=this.device.createBindGroup({layout:this.pipeline2d.getBindGroupLayout(0),entries:[{binding:0,resource:this.stagingTex.createView()},{binding:1,resource:this.sampler},{binding:2,resource:{buffer:this.uniformBuffer}},{binding:3,resource:{buffer:this.output.buffer}}]});this.dispatchOnce(this.pipeline2d,r)}runExternal(e){this.pipelineExternal||(this.pipelineExternal=this.buildPipeline(this.dtype==="f16"?$o:qo));let r=this.device.importExternalTexture({source:e}),t=this.device.createBindGroup({layout:this.pipelineExternal.getBindGroupLayout(0),entries:[{binding:0,resource:r},{binding:1,resource:this.sampler},{binding:2,resource:{buffer:this.uniformBuffer}},{binding:3,resource:{buffer:this.output.buffer}}]});this.dispatchOnce(this.pipelineExternal,t)}ensureStagingTexture(e,r){this.stagingTex&&this.stagingW===e&&this.stagingH===r||(this.stagingTex?.destroy(),this.stagingTex=this.device.createTexture({size:[e,r,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT}),this.stagingW=e,this.stagingH=r)}buildPipeline(e){let r=this.device.createShaderModule({code:e});return this.device.createComputePipeline({layout:"auto",compute:{module:r,entryPoint:"main"}})}dispatchOnce(e,r){let t=this.device.createCommandEncoder(),a=t.beginComputePass();a.setPipeline(e),a.setBindGroup(0,r),a.dispatchWorkgroups(...this.dispatch),a.end(),this.device.queue.submit([t.finish()])}};var Zs=navigator.gpu?GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST:0,ne=class u{constructor(e,r,t){i(this,"device",e);i(this,"canvas",r);i(this,"dtype",t);i(this,"ops");i(this,"presenters");i(this,"canvasContext");i(this,"canvasFormat");i(this,"bytesPerElement");i(this,"contexts",new Map);this.bytesPerElement=t==="f16"?2:4;let a=r.getContext("webgpu");if(!a)throw new Error("Failed to get WebGPU context from canvas");this.canvasFormat=navigator.gpu.getPreferredCanvasFormat(),this.configureContext(a),this.canvasContext=a,this.contexts.set("main",a),this.ops={Conv2d:(o,n,s)=>new Fe(this,o,n,s),ConvTranspose2d:(o,n,s)=>new Ee(this,o,n,s),DepthwiseConv2d:(o,n,s)=>new Re(this,o,n,s),Add:(o,n)=>new De(this,o,n),Sigmoid:o=>new Oe(this,o),Tanh:o=>new Ie(this,o),ElementwiseMul:(o,n)=>new Me(this,o,n),Warp:(o,n,s)=>new ze(this,o,n,s),FaceBoxFromHeatmaps:(o,n)=>new He(this,o,n),FaceBoxesFromHeatmaps:(o,n)=>new Ne(this,o,n),ReframeState:(o,n,s,p)=>new Ve(this,o,n,s,p),Reframe:(o,n)=>new Xe(this,o,n),CropResample:(o,n,s)=>new je(this,o,n,s),FaceTouchupStage:(o,n,s,p,c)=>new Ke(this,o,n,s,p,c),Stabilize:(o,n,s,p,c)=>new Ye(this,o,n,s,p,c),BilinearUpsample:(o,n)=>new Qe(this,o,n),Crop:(o,n)=>new Je(this,o,n),BicubicUpsample:(o,n)=>new Ze(this,o,n),ChannelConcat:(o,n)=>new et(this,o,n),Conv2dAdd:(o,n,s,p)=>new tt(this,o,n,s,p),ProjResidual:(o,n,s,p)=>new rt(this,o,n,s,p),ConcatConv2d:(o,n,s,p)=>new ot(this,o,n,s,p),GatesFused:(o,n,s)=>new at(this,o,n,s),CandUpdateFused:(o,n,s,p,c)=>new it(this,o,n,s,p,c),ConvExpand:(o,n)=>new st(this,o,n),CatConv6to2:(o,n,s)=>new nt(this,o,n,s),DownAdapter:(o,n,s,p)=>new ut(this,o,n,s,p),UpFinal:(o,n,s)=>new pt(this,o,n,s),UpFinalSkip:(o,n,s,p)=>new ct(this,o,n,s,p),UpsampleConcat:(o,n,s)=>new lt(this,o,n,s),UpsampleConv1x1:(o,n,s)=>new ft(this,o,n,s),UpsampleSigmoid:(o,n)=>new dt(this,o,n),Input:(o,n)=>new bt(this,o,n)},this.presenters={CompositeSolid:(o,n,s,p="main")=>{let c=new mt(this,o,n,s);return{run:()=>{c.setOutput(this.getCurrentDisplayTexture(p)),c.run()}}},CompositeImage:(o,n,s,p="main")=>{let c=new ht(this,o,n,s);return{run:()=>{c.setOutput(this.getCurrentDisplayTexture(p)),c.run()}}},CompositeImageBilinear:(o,n,s,p="main")=>{let c=new gt(this,o,n,s);return{run:()=>{c.setOutput(this.getCurrentDisplayTexture(p)),c.run()}}},CompositePassthrough:(o,n="main")=>{let s=new _t(this,o);return{run:()=>{s.setOutput(this.getCurrentDisplayTexture(n)),s.run()}}},LandmarkOverlay:(o,n,s,p,c="main")=>{let l=new qe(this,o,n,s,p);return{run:()=>{l.setOutput(this.getCurrentDisplayTexture(c)),l.run()}}},FaceTouchup:(o,n,s,p,c,l="main")=>{let f=new $e(this,o,n,s,p,c);return{run:()=>{f.setOutput(this.getCurrentDisplayTexture(l)),f.run()}}}}}configureContext(e){e.configure({device:this.device,format:this.canvasFormat,alphaMode:"premultiplied"})}attachCanvas(e,r){if(e==="main")throw new Error("attachCanvas: 'main' is reserved for the create() canvas");let t=r.getContext("webgpu");if(!t)throw new Error(\`attachCanvas: failed to get WebGPU context for target '\${e}'\`);this.configureContext(t),this.contexts.set(e,t)}static async isAvailable(){return navigator.gpu?await navigator.gpu.requestAdapter()!==null:!1}static async hasF16Support(){if(!navigator.gpu)return!1;let e=await navigator.gpu.requestAdapter();return e?e.features.has("shader-f16"):!1}static async create(e){let r=e.dtype??"f32",t=e.device;if(t){if(r==="f16"&&!t.features.has("shader-f16"))throw new Error("WebGPU dtype='f16' requested but supplied device lacks \`shader-f16\`")}else{let a=await navigator.gpu.requestAdapter();if(!a)throw new Error("WebGPU adapter not available");if(r==="f16"&&!a.features.has("shader-f16"))throw new Error("WebGPU dtype='f16' requested but adapter lacks \`shader-f16\` feature");t=await a.requestDevice({requiredFeatures:r==="f16"?["shader-f16"]:[]})}return new u(t,e.canvas,r)}getCurrentDisplayTexture(e="main"){let r=this.contexts.get(e);if(!r)throw new Error(\`getCurrentDisplayTexture: no canvas attached for target '\${e}'\`);return r.getCurrentTexture()}tensor(e,r,t,a){let n=e*r*t*this.bytesPerElement,s=this.device.createBuffer({size:n,usage:Zs,mappedAtCreation:a!==void 0});if(a!==void 0){let p=s.getMappedRange();this.writeView(p,a),s.unmap()}return{h:e,w:r,c:t,buffer:s}}upload(e){let t=e.length*this.bytesPerElement,a=this.device.createBuffer({size:t,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,mappedAtCreation:!0});return this.writeView(a.getMappedRange(),e),a.unmap(),{buffer:a}}writeView(e,r){let t=this.dtype==="f16",a=r instanceof Uint16Array;if(t===a){t?new Uint16Array(e).set(r):new Float32Array(e).set(r);return}t?new Uint16Array(e).set(Le(r)):new Float32Array(e).set(ae(r))}async readback(e){let r=this.device.createBuffer({size:e.buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),t=this.device.createCommandEncoder();t.copyBufferToBuffer(e.buffer,0,r,0,e.buffer.size),this.device.queue.submit([t.finish()]),await r.mapAsync(GPUMapMode.READ);let a=r.getMappedRange(),o=this.dtype==="f16"?ae(new Uint16Array(a.slice(0))):new Float32Array(a.slice(0));return r.unmap(),r.destroy(),o}copyTensor(e,r){if(e.buffer.size!==r.buffer.size)throw new Error(\`copyTensor: size mismatch (src \${e.buffer.size} vs dst \${r.buffer.size})\`);let t=this.device.createCommandEncoder();t.copyBufferToBuffer(e.buffer,0,r.buffer,0,e.buffer.size),this.device.queue.submit([t.finish()])}async sync(){await this.device.queue.onSubmittedWorkDone()}destroy(){this.device.destroy()}};var en=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,g=class{constructor(e){i(this,"backend",e);i(this,"shader","");i(this,"program");i(this,"samplers",[]);i(this,"uniformInts",{});i(this,"uniformFloats",{})}makeTexture(e,r,t){let a=this.backend.gl,o=this.backend.textureFormat,n=this.backend.toTextureView(e),s=a.createTexture();return a.bindTexture(a.TEXTURE_2D,s),a.texImage2D(a.TEXTURE_2D,0,o.internalFormat,r,t,0,o.format,o.type,n),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MIN_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MAG_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_S,a.CLAMP_TO_EDGE),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_T,a.CLAMP_TO_EDGE),s}defaultSetup(){let e=this.backend.gl,r=e.createShader(e.VERTEX_SHADER);e.shaderSource(r,en),e.compileShader(r);let t=e.createShader(e.FRAGMENT_SHADER);if(e.shaderSource(t,this.shader),e.compileShader(t),!e.getShaderParameter(t,e.COMPILE_STATUS))throw new Error(\`GLSL compile error: \${e.getShaderInfoLog(t)}\`);if(this.program=e.createProgram(),e.attachShader(this.program,r),e.attachShader(this.program,t),e.linkProgram(this.program),!e.getProgramParameter(this.program,e.LINK_STATUS))throw new Error(\`GLSL link error: \${e.getProgramInfoLog(this.program)}\`)}run(){let e=this.backend.gl;e.useProgram(this.program),this.samplers.forEach(({name:r,texture:t},a)=>{e.activeTexture(e.TEXTURE0+a),e.bindTexture(e.TEXTURE_2D,t),e.uniform1i(e.getUniformLocation(this.program,r),a)});for(let[r,t]of Object.entries(this.uniformInts))e.uniform1i(e.getUniformLocation(this.program,r),t);for(let[r,t]of Object.entries(this.uniformFloats))e.uniform1f(e.getUniformLocation(this.program,r),t);e.bindFramebuffer(e.FRAMEBUFFER,this.backend.fbo),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,this.output.texture,0),e.viewport(0,0,this.dispatch[0],this.dispatch[1]),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6)}};var Ko=\`#version 300 es
// Conv2d \\u2014 handles all variants: 1\\xD71 (pointwise), 3\\xD73, 5\\xD75, strided, BN-fused.
//
// Tensor layout: NHWC vec4 \\u2014 texture dimensions (W * C/4, H).
//   texel (x * C_groups + c_group, y) = channels [c_group*4 .. c_group*4+3] at pixel (x,y).
//
// Weight layout: (I_groups * 4, K\\xB2 * O_groups) RGBA32F texture.
//   Row  = z * u_out_c_groups + o_group   (kernel_pos outer, out_group inner)
//   Col  = i_group * 4 + mat_col          (4 texels per mat4)
//   mat4[col][row] = weight(in_channel=col, out_channel=row)
//   Operation: (mat4 * in_val)[r] = \\u03A3_c weight(in=c, out=r) * in_val[c]  \\u2014 same as WGSL.
//
// Bias layout: (O_groups, 1).
//
// Padding model: pad_top / pad_left applied to input offset; right/bottom asymmetry
// is handled implicitly by the bounds check, same as the WGSL implementation.

precision highp float;
precision highp int;

uniform sampler2D u_input;    // (in_W * in_C_groups, in_H)
uniform sampler2D u_weights;  // (in_C_groups * 4, K\\xB2 * out_C_groups)
uniform sampler2D u_bias;     // (out_C_groups, 1)

uniform int u_in_w;
uniform int u_in_h;
uniform int u_in_c_groups;
uniform int u_out_c_groups;
uniform int u_kernel_h;
uniform int u_kernel_w;
uniform int u_stride;
uniform int u_pad_top;
uniform int u_pad_left;
uniform int u_activation;   // 0 = none, 1 = relu6, 2 = relu, 3 = leaky(0.1)

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_out_c_groups;
    int y_out   = fy;
    int o_group = fx - x_out * u_out_c_groups;

    vec4 result = texelFetch(u_bias, ivec2(o_group, 0), 0);

    for (int ky = 0; ky < u_kernel_h; ky++) {
        for (int kx = 0; kx < u_kernel_w; kx++) {
            int in_y = y_out * u_stride + ky - u_pad_top;
            int in_x = x_out * u_stride + kx - u_pad_left;

            if (in_y < 0 || in_y >= u_in_h || in_x < 0 || in_x >= u_in_w) continue;

            int z     = ky * u_kernel_w + kx;
            int w_row = z * u_out_c_groups + o_group;

            for (int i = 0; i < u_in_c_groups; i++) {
                vec4 in_val = texelFetch(u_input, ivec2(in_x * u_in_c_groups + i, in_y), 0);

                int base = i * 4;
                mat4 w = mat4(
                    texelFetch(u_weights, ivec2(base,     w_row), 0),
                    texelFetch(u_weights, ivec2(base + 1, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 2, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 3, w_row), 0)
                );
                result += w * in_val;
            }
        }
    }

    if      (u_activation == 1) result = clamp(result, 0.0, 6.0);
    else if (u_activation == 2) result = max(result, vec4(0.0));
    else if (u_activation == 3) result = max(result, 0.1 * result);

    fragColor = result;
}
\`;var vt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Ko);let n=C(t.h,o.kernel,o.stride,o.padding),s=C(t.w,o.kernel,o.stride,o.padding),p=t.c/4,c=o.outChannels/4,l=G(o.padding,t.h,n,o.kernel,o.stride),f=G(o.padding,t.w,s,o.kernel,o.stride),d=m(a.weights),_=m(a.bias),b=this.makeTexture(d,p*4,o.kernel*o.kernel*c),x=this.makeTexture(_,c,1),v=s*c,y=this.makeTexture(null,v,n);this.output={h:n,w:s,c:o.outChannels,texture:y,texW:v,texH:n},this.inputs=[t],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_weights",texture:b},{name:"u_bias",texture:x}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_in_c_groups:p,u_out_c_groups:c,u_kernel_h:o.kernel,u_kernel_w:o.kernel,u_stride:o.stride,u_pad_top:l,u_pad_left:f,u_activation:o.activation==="relu6"?1:o.activation==="relu"?2:o.activation==="leaky"?3:0},this.defaultSetup(),this.dispatch=[v,n]}};var Yo=\`#version 300 es
// ConvTranspose2d \\u2014 gather form. Identical texture layouts + mat4 weight
// semantics as conv2d.glsl; only the spatial mapping differs:
//   in_y = (y_out + pad - ky) / stride   (must divide evenly + be in bounds)
// No explicit kernel flip \\u2014 the (y_out + pad - ky) indexing carries it.

precision highp float;
precision highp int;

uniform sampler2D u_input;    // (in_W * in_C_groups, in_H)
uniform sampler2D u_weights;  // (in_C_groups * 4, K\\xB2 * out_C_groups)
uniform sampler2D u_bias;     // (out_C_groups, 1)

uniform int u_in_w;
uniform int u_in_h;
uniform int u_in_c_groups;
uniform int u_out_c_groups;
uniform int u_kernel_h;
uniform int u_kernel_w;
uniform int u_stride;
uniform int u_pad_top;
uniform int u_pad_left;
uniform int u_activation;   // 0 = none, 1 = relu6, 2 = relu, 3 = leaky(0.1)

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_out_c_groups;
    int y_out   = fy;
    int o_group = fx - x_out * u_out_c_groups;

    vec4 result = texelFetch(u_bias, ivec2(o_group, 0), 0);

    for (int ky = 0; ky < u_kernel_h; ky++) {
        for (int kx = 0; kx < u_kernel_w; kx++) {
            int iy_num = y_out + u_pad_top  - ky;
            int ix_num = x_out + u_pad_left - kx;
            if (iy_num < 0 || ix_num < 0) continue;
            if ((iy_num % u_stride) != 0 || (ix_num % u_stride) != 0) continue;
            int in_y = iy_num / u_stride;
            int in_x = ix_num / u_stride;
            if (in_y >= u_in_h || in_x >= u_in_w) continue;

            int z     = ky * u_kernel_w + kx;
            int w_row = z * u_out_c_groups + o_group;

            for (int i = 0; i < u_in_c_groups; i++) {
                vec4 in_val = texelFetch(u_input, ivec2(in_x * u_in_c_groups + i, in_y), 0);

                int base = i * 4;
                mat4 w = mat4(
                    texelFetch(u_weights, ivec2(base,     w_row), 0),
                    texelFetch(u_weights, ivec2(base + 1, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 2, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 3, w_row), 0)
                );
                result += w * in_val;
            }
        }
    }

    if      (u_activation == 1) result = clamp(result, 0.0, 6.0);
    else if (u_activation == 2) result = max(result, vec4(0.0));
    else if (u_activation == 3) result = max(result, 0.1 * result);

    fragColor = result;
}
\`;var xt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Yo);let n=ie(t.h,o.kernel,o.stride,o.padding),s=ie(t.w,o.kernel,o.stride,o.padding),p=t.c/4,c=o.outChannels/4,l=m(a.weights),f=m(a.bias),d=this.makeTexture(l,p*4,o.kernel*o.kernel*c),_=this.makeTexture(f,c,1),b=s*c,x=this.makeTexture(null,b,n);this.output={h:n,w:s,c:o.outChannels,texture:x,texW:b,texH:n},this.inputs=[t],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_weights",texture:d},{name:"u_bias",texture:_}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_in_c_groups:p,u_out_c_groups:c,u_kernel_h:o.kernel,u_kernel_w:o.kernel,u_stride:o.stride,u_pad_top:o.padding,u_pad_left:o.padding,u_activation:o.activation==="relu6"?1:o.activation==="relu"?2:o.activation==="leaky"?3:0},this.defaultSetup(),this.dispatch=[b,n]}};var Qo=\`#version 300 es
// Depthwise Conv2d \\u2014 groups = in_channels (each channel convolved independently).
//
// Weight layout: (C_groups, K\\xB2) RGBA32F texture \\u2014 contrast with conv2d which uses mat4.
//   texel (c_group, z) = vec4 kernel weights for 4 channels at kernel position z.
//   Operation: element-wise multiply (not matmul). 4\\xD7 smaller than a mat4 approach.
//
// Padding model: same asymmetric SAME-pad handling as conv2d.glsl.

precision highp float;
precision highp int;

uniform sampler2D u_input;    // (in_W * C_groups, in_H)
uniform sampler2D u_weights;  // (C_groups, K\\xB2)
uniform sampler2D u_bias;     // (C_groups, 1)

uniform int u_in_w;
uniform int u_in_h;
uniform int u_c_groups;
uniform int u_kernel_h;
uniform int u_kernel_w;
uniform int u_stride;
uniform int u_pad_top;
uniform int u_pad_left;
uniform int u_apply_relu6;   // 0 = none, 1 = relu6

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_c_groups;
    int y_out   = fy;
    int c_group = fx - x_out * u_c_groups;

    vec4 result = texelFetch(u_bias, ivec2(c_group, 0), 0);

    for (int ky = 0; ky < u_kernel_h; ky++) {
        for (int kx = 0; kx < u_kernel_w; kx++) {
            int in_y = y_out * u_stride + ky - u_pad_top;
            int in_x = x_out * u_stride + kx - u_pad_left;

            if (in_y < 0 || in_y >= u_in_h || in_x < 0 || in_x >= u_in_w) continue;

            int z = ky * u_kernel_w + kx;

            vec4 in_val = texelFetch(u_input,   ivec2(in_x * u_c_groups + c_group, in_y), 0);
            vec4 w      = texelFetch(u_weights, ivec2(c_group, z), 0);

            result += w * in_val;  // element-wise multiply, not matmul
        }
    }

    if (u_apply_relu6 == 1) result = clamp(result, 0.0, 6.0);

    fragColor = result;
}
\`;var yt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Qo);let n=C(t.h,o.kernel,o.stride,o.padding),s=C(t.w,o.kernel,o.stride,o.padding),p=t.c/4,c=G(o.padding,t.h,n,o.kernel,o.stride),l=G(o.padding,t.w,s,o.kernel,o.stride),f=m(a.weights),d=m(a.bias),_=this.makeTexture(f,p,o.kernel*o.kernel),b=this.makeTexture(d,p,1),x=s*p,v=this.makeTexture(null,x,n);this.output={h:n,w:s,c:t.c,texture:v,texW:x,texH:n},this.inputs=[t],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_weights",texture:_},{name:"u_bias",texture:b}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_c_groups:p,u_kernel_h:o.kernel,u_kernel_w:o.kernel,u_stride:o.stride,u_pad_top:c,u_pad_left:l,u_apply_relu6:o.activation==="relu6"?1:0},this.defaultSetup(),this.dispatch=[x,n]}};var Jo=\`#version 300 es
// Element-wise add \\u2014 both inputs and output share the same texture dimensions.
// Works for any 2D layout; used here with a flat (nVec4, 1) texture.

precision highp float;

uniform sampler2D u_input_a;
uniform sampler2D u_input_b;

out vec4 fragColor;

void main() {
    ivec2 fc = ivec2(gl_FragCoord.xy);
    fragColor = texelFetch(u_input_a, fc, 0) + texelFetch(u_input_b, fc, 0);
}
\`;var wt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",Jo);let o=t,n=this.makeTexture(null,o.texW,o.texH);this.output={h:t.h,w:t.w,c:t.c,texture:n,texW:o.texW,texH:o.texH},this.inputs=[t,a],this.samplers=[{name:"u_input_a",texture:t.texture},{name:"u_input_b",texture:a.texture}],this.defaultSetup(),this.dispatch=[o.texW,o.texH]}};var Zo=\`#version 300 es
// Element-wise sigmoid \\u2014 works on any texture layout (flat or spatial).

precision highp float;

uniform sampler2D u_input;

out vec4 fragColor;

void main() {
    vec4 x = texelFetch(u_input, ivec2(gl_FragCoord.xy), 0);
    fragColor = 1.0 / (1.0 + exp(-x));
}
\`;var kt=class extends g{constructor(r,t){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",Zo);let a=t,o=this.makeTexture(null,a.texW,a.texH);this.output={h:t.h,w:t.w,c:t.c,texture:o,texW:a.texW,texH:a.texH},this.inputs=[t],this.samplers=[{name:"u_input",texture:a.texture}],this.defaultSetup(),this.dispatch=[a.texW,a.texH]}};var ea=\`#version 300 es
// Element-wise tanh \\u2014 used by ConvGRU candidate activation.
// Layout-agnostic (flat or spatial); GLSL tanh is element-wise on vec4.

precision highp float;

uniform sampler2D u_input;

out vec4 fragColor;

void main() {
    fragColor = tanh(texelFetch(u_input, ivec2(gl_FragCoord.xy), 0));
}
\`;var Tt=class extends g{constructor(r,t){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",ea);let a=t,o=this.makeTexture(null,a.texW,a.texH);this.output={h:t.h,w:t.w,c:t.c,texture:o,texW:a.texW,texH:a.texH},this.inputs=[t],this.samplers=[{name:"u_input",texture:a.texture}],this.defaultSetup(),this.dispatch=[a.texW,a.texH]}};var ta=\`#version 300 es
// Element-wise multiply \\u2014 used in ConvGRU for r \\u2299 h_prev.
// Same shape constraint as add.glsl.

precision highp float;

uniform sampler2D u_input_a;
uniform sampler2D u_input_b;

out vec4 fragColor;

void main() {
    ivec2 fc = ivec2(gl_FragCoord.xy);
    fragColor = texelFetch(u_input_a, fc, 0) * texelFetch(u_input_b, fc, 0);
}
\`;var Pt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",ta);let o=t,n=this.makeTexture(null,o.texW,o.texH);this.output={h:t.h,w:t.w,c:t.c,texture:n,texW:o.texW,texH:o.texH},this.inputs=[t,a],this.samplers=[{name:"u_input_a",texture:t.texture},{name:"u_input_b",texture:a.texture}],this.defaultSetup(),this.dispatch=[o.texW,o.texH]}};var ra=\`#version 300 es
// Bilinear gather-warp. out[p] = sample(source, p + flow_scale\\xB7flow[p].xy),
// edge-clamped. Source/output are (W\\xB7G, H) with G = c/4 channel groups
// (fragment x decomposes to pixel + group, like conv); flow is 4-ch, same
// spatial resolution, vector in .xy.

precision highp float;
precision highp int;

uniform sampler2D u_source;   // (W * G, H)
uniform sampler2D u_flow;     // (W, H), flow in .xy
uniform int   u_w;
uniform int   u_h;
uniform int   u_groups;
uniform float u_flow_scale;

out vec4 fragColor;

vec4 samp(int x, int y, int g) {
    int cx = clamp(x, 0, u_w - 1);
    int cy = clamp(y, 0, u_h - 1);
    return texelFetch(u_source, ivec2(cx * u_groups + g, cy), 0);
}

void main() {
    int fx = int(gl_FragCoord.x);
    int y  = int(gl_FragCoord.y);
    int x  = fx / u_groups;
    int g  = fx - x * u_groups;

    vec2 f  = texelFetch(u_flow, ivec2(x, y), 0).xy;
    float sx = clamp(float(x) + u_flow_scale * f.x, 0.0, float(u_w - 1));
    float sy = clamp(float(y) + u_flow_scale * f.y, 0.0, float(u_h - 1));

    int x0 = int(floor(sx));
    int y0 = int(floor(sy));
    float tx = sx - float(x0);
    float ty = sy - float(y0);

    vec4 top = mix(samp(x0, y0, g), samp(x0 + 1, y0, g), tx);
    vec4 bot = mix(samp(x0, y0 + 1, g), samp(x0 + 1, y0 + 1, g), tx);
    fragColor = mix(top, bot, ty);
}
\`;var Ct=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",ra);let n=t.w,s=t.h,p=t.c/4,c=this.makeTexture(null,n*p,s);this.output={h:s,w:n,c:t.c,texture:c,texW:n*p,texH:s},this.inputs=[t,a],this.samplers=[{name:"u_source",texture:t.texture},{name:"u_flow",texture:a.texture}],this.uniformInts={u_w:n,u_h:s,u_groups:p},this.uniformFloats={u_flow_scale:o.flowScale},this.defaultSetup(),this.dispatch=[n*p,s]}};var oa=\`#version 300 es
// Face-box decode from 5-keypoint heatmaps. Output is a 1\\xD71 texture:
// (cx, cy, halfSide, score) in FRAME FRACTIONS (halfSide as a fraction of
// frame WIDTH; the heatmap grid shares the frame's aspect, so squaring in
// grid px squares in frame px). Peaks refined with a windowed soft-argmax
// centroid \\u2014 NEVER hard argmax (whole-cell snapping jitters the crop).
//
// Single fragment does all 5 channels serially \\u2014 the grid is tiny (\\u2264 ~48\\xD728).
// Heatmap texture: (w * 2, h) \\u2014 8 channels = 2 vec4 groups per pixel.

precision highp float;
precision highp int;

uniform sampler2D u_hm;
uniform int u_h;
uniform int u_w;
uniform int u_win;
uniform float u_thresh;
uniform float u_box_scale;

out vec4 fragColor;

float hmAt(int x, int y, int k) {
    vec4 v = texelFetch(u_hm, ivec2(x * 2 + k / 4, y), 0);
    return v[k % 4];
}

void main() {
    float x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, score = 1e9;

    for (int k = 0; k < 5; k++) {
        // Peak.
        float peak = -1.0;
        int pr = 0, pc = 0;
        for (int y = 0; y < u_h; y++) {
            for (int x = 0; x < u_w; x++) {
                float v = hmAt(x, y, k);
                if (v > peak) { peak = v; pr = y; pc = x; }
            }
        }
        // Windowed soft-argmax centroid.
        int r0 = max(0, pr - u_win), r1 = min(u_h, pr + u_win + 1);
        int c0 = max(0, pc - u_win), c1 = min(u_w, pc + u_win + 1);
        float wsum = 0.0, sy = 0.0, sx = 0.0;
        for (int y = r0; y < r1; y++) {
            for (int x = c0; x < c1; x++) {
                float v = hmAt(x, y, k);
                wsum += v; sy += v * float(y); sx += v * float(x);
            }
        }
        wsum = max(wsum, 1e-6);
        float kx = sx / wsum, ky = sy / wsum;
        x0 = min(x0, kx); x1 = max(x1, kx);
        y0 = min(y0, ky); y1 = max(y1, ky);
        score = min(score, peak);
    }
    if (score < u_thresh) score = 0.0;

    float halfPx = 0.5 * u_box_scale * max(x1 - x0, y1 - y0);
    float cx = ((x0 + x1) * 0.5 + 0.5) / float(u_w);
    float cy = ((y0 + y1) * 0.5 + 0.5) / float(u_h);
    fragColor = vec4(cx, cy, halfPx / float(u_w), score);
}
\`;var Wt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch",[1,1]);i(this,"shader",oa);if(t.c!==8)throw new Error(\`FaceBoxFromHeatmaps: expected 8-ch heatmaps (5 real), got \${t.c}\`);let o=this.makeTexture(null,1,1);this.output={h:1,w:1,c:4,texture:o,texW:1,texH:1},this.inputs=[t],this.samplers=[{name:"u_hm",texture:t.texture}],this.uniformInts={u_h:t.h,u_w:t.w,u_win:a.win},this.uniformFloats={u_thresh:a.thresh,u_box_scale:a.boxScale},this.defaultSetup()}};var aa=\`#version 300 es
// MULTI-FACE box decode from 5-keypoint heatmaps \\u2192 1\\xD7K texture, slot i =
// (cx, cy, halfSide, score) in FRAME FRACTIONS (halfSide a fraction of frame
// WIDTH). The multi-face sibling of face_box.glsl. See face_boxes.wgsl for the
// full algorithm commentary \\u2014 this mirrors it exactly.
//
// WebGL has no compute and no shared memory, so each fragment (= one face slot)
// independently redoes the ENTIRE decode \\u2014 candidates for all 5 channels,
// hypotheses, NMS \\u2014 and emits the slot matching its own x. That's K\\xD7 redundant
// work, which is fine here: the grid is \\u2264 ~48\\xD728 and K \\u2264 6, and it keeps the
// WGSL and GLSL paths line-for-line comparable.
//
// Heatmap texture: (w * 2, h) \\u2014 8 channels = 2 vec4 groups per pixel.

precision highp float;
precision highp int;

uniform sampler2D u_hm;
uniform int u_h;
uniform int u_w;
uniform int u_win;
uniform float u_thresh;
uniform float u_box_scale;
uniform int u_max_faces;
uniform float u_tol;

out vec4 fragColor;

const int N_KP     = 5;
const int MAX_CAND = 5;
const float LAMBDA  = 0.5;
const float MIN_SEP = 1.0;
const float MIN_EYE = 1.0;

float c_x[25];
float c_y[25];
float c_s[25];
int   c_n[5];

float hmAt(int x, int y, int k) {
    vec4 v = texelFetch(u_hm, ivec2(x * 2 + k / 4, y), 0);
    return v[k % 4];
}

// ArcFace canonical template in the eye frame (origin = L-eye, +u along the
// L\\u2192R eye vector, +w perpendicular), normalized by interocular distance.
float tmplU(int t) { return t == 0 ? 0.50002 : (t == 1 ? 0.08598 : 0.91410); }
float tmplW(int t) { return t == 0 ? 0.57150 : 1.15462; }

void main() {
    int myFace = int(gl_FragCoord.x);

    // \\u2500\\u2500 stage 1: local-maximum candidates, per channel \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    for (int k = 0; k < N_KP; k++) {
        int   pr[5];
        int   pc[5];
        float ps[5];
        int n = 0;

        for (int y = 0; y < u_h; y++) {
            for (int x = 0; x < u_w; x++) {
                float v = hmAt(x, y, k);
                if (v < u_thresh) continue;

                bool isMax = true;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        int rr = y + dy, cc = x + dx;
                        if (rr < 0 || rr >= u_h || cc < 0 || cc >= u_w) continue;
                        float u = hmAt(cc, rr, k);
                        if (u > v || (u == v && rr * u_w + cc < y * u_w + x)) isMax = false;
                    }
                }
                if (!isMax) continue;

                int slot = n;
                if (n == MAX_CAND) {
                    if (v <= ps[MAX_CAND - 1]) continue;
                    slot = MAX_CAND - 1;
                } else {
                    n++;
                }
                while (slot > 0 && ps[slot - 1] < v) {
                    ps[slot] = ps[slot - 1]; pr[slot] = pr[slot - 1]; pc[slot] = pc[slot - 1];
                    slot--;
                }
                ps[slot] = v; pr[slot] = y; pc[slot] = x;
            }
        }

        int m = 0;
        for (int i = 0; i < n; i++) {
            float rx = float(pc[i]);
            float ry = float(pr[i]);
            if (u_win > 0) {
                int r0 = max(0, pr[i] - u_win), r1 = min(u_h, pr[i] + u_win + 1);
                int c0 = max(0, pc[i] - u_win), c1 = min(u_w, pc[i] + u_win + 1);
                float wsum = 0.0, sy = 0.0, sx = 0.0;
                for (int y = r0; y < r1; y++) {
                    for (int x = c0; x < c1; x++) {
                        float v = hmAt(x, y, k);
                        wsum += v; sy += v * float(y); sx += v * float(x);
                    }
                }
                wsum = max(wsum, 1e-6);
                rx = sx / wsum; ry = sy / wsum;
            }
            bool dup = false;
            for (int j = 0; j < m; j++) {
                float dx = c_x[k * MAX_CAND + j] - rx;
                float dy = c_y[k * MAX_CAND + j] - ry;
                if (sqrt(dx * dx + dy * dy) < MIN_SEP) dup = true;
            }
            if (dup) continue;
            c_x[k * MAX_CAND + m] = rx;
            c_y[k * MAX_CAND + m] = ry;
            c_s[k * MAX_CAND + m] = ps[i];
            m++;
        }
        c_n[k] = m;
    }

    // \\u2500\\u2500 stage 2: eye-pair hypotheses \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    float h_score[25];
    int   h_kp[125];
    int nh = 0;
    float maxEye = float(u_w) * 0.45;

    for (int i = 0; i < c_n[0]; i++) {
        for (int j = 0; j < c_n[1]; j++) {
            float ax = c_x[i], ay = c_y[i];
            float bx = c_x[MAX_CAND + j], by = c_y[MAX_CAND + j];
            float evx = bx - ax, evy = by - ay;
            float len = sqrt(evx * evx + evy * evy);
            if (len < MIN_EYE || len > maxEye) continue;
            vec2 ex = vec2(evx / len, evy / len);
            vec2 ey = vec2(-ex.y, ex.x);

            float sc = c_s[i] + c_s[MAX_CAND + j];
            float resid = 0.0;
            int nMatch = 2, mouths = 0, nose = -1;
            int mo[2];
            mo[0] = -1; mo[1] = -1;

            for (int t = 0; t < 3; t++) {
                int kk = t + 2;
                float px = ax + len * (tmplU(t) * ex.x + tmplW(t) * ey.x);
                float py = ay + len * (tmplU(t) * ex.y + tmplW(t) * ey.y);
                int best = -1;
                float bestD = u_tol * len;
                for (int q = 0; q < c_n[kk]; q++) {
                    float dx = c_x[kk * MAX_CAND + q] - px;
                    float dy = c_y[kk * MAX_CAND + q] - py;
                    float d = sqrt(dx * dx + dy * dy);
                    if (d < bestD) { bestD = d; best = q; }
                }
                if (best < 0) continue;
                sc += c_s[kk * MAX_CAND + best];
                resid += bestD / len;
                nMatch++;
                if (t == 0) nose = best; else { mo[t - 1] = best; mouths++; }
            }
            if (nose < 0 || mouths < 1) continue;

            h_score[nh] = sc / float(nMatch) - LAMBDA * (resid / float(nMatch - 2));
            h_kp[nh * N_KP + 0] = i;
            h_kp[nh * N_KP + 1] = j;
            h_kp[nh * N_KP + 2] = nose;
            h_kp[nh * N_KP + 3] = mo[0];
            h_kp[nh * N_KP + 4] = mo[1];
            nh++;
        }
    }

    // \\u2500\\u2500 stage 3/4: greedy NMS \\u2192 the box for slot myFace \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500
    bool used[25];
    for (int i = 0; i < N_KP * MAX_CAND; i++) used[i] = false;
    int outN = 0;

    for (int iter = 0; iter < 25; iter++) {
        if (outN >= u_max_faces) break;

        int best = -1;
        float bestS = -1e8;
        for (int q = 0; q < nh; q++) {
            if (h_score[q] > bestS) { bestS = h_score[q]; best = q; }
        }
        if (best < 0) break;
        h_score[best] = -1e9;

        bool clash = false;
        for (int t = 0; t < N_KP; t++) {
            int ci = h_kp[best * N_KP + t];
            if (ci < 0) continue;
            if (used[t * MAX_CAND + ci]) clash = true;
        }
        if (clash) continue;

        float x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, score = 1e9;
        for (int t = 0; t < N_KP; t++) {
            int ci = h_kp[best * N_KP + t];
            if (ci < 0) continue;
            int e = t * MAX_CAND + ci;
            used[e] = true;
            x0 = min(x0, c_x[e]); x1 = max(x1, c_x[e]);
            y0 = min(y0, c_y[e]); y1 = max(y1, c_y[e]);
            score = min(score, c_s[e]);
        }

        if (outN == myFace) {
            float halfPx = 0.5 * u_box_scale * max(x1 - x0, y1 - y0);
            float cx = ((x0 + x1) * 0.5 + 0.5) / float(u_w);
            float cy = ((y0 + y1) * 0.5 + 0.5) / float(u_h);
            fragColor = vec4(cx, cy, halfPx / float(u_w), score);
            return;
        }
        outN++;
    }

    fragColor = vec4(0.0);   // no face in this slot
}
\`;var Gt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",aa);if(t.c!==8)throw new Error(\`FaceBoxesFromHeatmaps: expected 8-ch heatmaps (5 real), got \${t.c}\`);if(a.maxFaces<1||a.maxFaces>6)throw new Error(\`FaceBoxesFromHeatmaps: maxFaces must be 1..6, got \${a.maxFaces}\`);let o=a.maxFaces;this.dispatch=[o,1];let n=this.makeTexture(null,o,1);this.output={h:1,w:o,c:4,texture:n,texW:o,texH:1},this.inputs=[t],this.samplers=[{name:"u_hm",texture:t.texture}],this.uniformInts={u_h:t.h,u_w:t.w,u_win:a.win,u_max_faces:o},this.uniformFloats={u_thresh:a.thresh,u_box_scale:a.boxScale,u_tol:a.tol},this.defaultSetup()}};var ia=\`#version 300 es
// Auto-reframe state update \\u2192 1\\xD71\\xD78 tensor, i.e. a 2\\xD71 texture of vec4 groups:
//   x=0  (cx, cy, size, moving)          \\u2014 the view rect
//   x=1  (subjX, subjY, subjHs, valid)   \\u2014 the incumbent subject, for hysteresis
// See reframe_state.wgsl for the full commentary \\u2014 this mirrors it.
//
// A fragment shader writes ONE vec4, so both fragments redo the whole (tiny)
// computation and each emits its own group \\u2014 same shape as face_boxes.glsl.

precision highp float;
precision highp int;

uniform sampler2D u_box;    // 1\\xD7K \\u2014 (cx, cy, halfSide/W, score)
uniform sampler2D u_prev;   // 1\\xD71 \\u2014 previous state
uniform sampler2D u_cmd;    // 1\\xD71 \\u2014 .x = mode
uniform int   u_k;
uniform float u_zoom;
uniform float u_gravity;
uniform float u_margin;
uniform float u_deadband;
uniform float u_ease;
uniform float u_aspect;     // frame w/h

out vec4 fragColor;

const float MODE_HOLD  = 1.0;
const float MODE_SOLVE = 2.0;
const float SWITCH_RATIO     = 1.25;
const float TRACK_RADIUS_MIN = 0.1;

void main() {
    int group = int(gl_FragCoord.x);   // 0 = view rect, 1 = subject memory
    vec4 prev  = texelFetch(u_prev, ivec2(0, 0), 0);
    vec4 prevS = texelFetch(u_prev, ivec2(1, 0), 0);
    float mode = texelFetch(u_cmd, ivec2(0, 0), 0).x;

    // Challenger = largest live face.
    int chal = -1;
    float chalHs = 0.0;
    for (int i = 0; i < u_k; i++) {
        vec4 b = texelFetch(u_box, ivec2(i, 0), 0);
        if (b.w > 0.0 && b.z > chalHs) { chalHs = b.z; chal = i; }
    }
    if (chal < 0) {
        // Hold, and keep the subject memory \\u2014 a one-frame detection miss must not
        // hand the camera to someone else.
        fragColor = (group == 0) ? prev : prevS;
        return;
    }

    // Incumbent = the live face nearest where the subject was (slot indices are
    // not stable identities, so it's tracked by position).
    int inc = -1;
    float incD = 1e9;
    if (prevS.w > 0.5) {
        float radius = max(TRACK_RADIUS_MIN, prevS.z * 2.0);
        for (int i = 0; i < u_k; i++) {
            vec4 b = texelFetch(u_box, ivec2(i, 0), 0);
            if (b.w <= 0.0) continue;
            float d = length(vec2(b.x - prevS.x, b.y - prevS.y));
            if (d < radius && d < incD) { incD = d; inc = i; }
        }
    }

    int pick = chal;
    if (inc >= 0 && chalHs <= texelFetch(u_box, ivec2(inc, 0), 0).z * SWITCH_RATIO) pick = inc;
    vec4 subj = texelFetch(u_box, ivec2(pick, 0), 0);
    if (group == 1) { fragColor = vec4(subj.x, subj.y, subj.z, 1.0); return; }

    float halfX = subj.z;
    float halfY = subj.z * u_aspect;
    // Fallback = the full frame (no reframe) \\u2014 see reframe_state.wgsl.
    float wcx = 0.5, wcy = 0.5, ws = 1.0;
    for (int t = 0; t <= 25; t++) {
        float z = u_zoom + (1.0 - u_zoom) * (float(t) / 25.0);
        float s = 1.0 / z;
        float cx = clamp(0.5 + u_gravity * (subj.x - 0.5), s * 0.5, 1.0 - s * 0.5);
        float cy = clamp(0.5 + u_gravity * (subj.y - 0.5), s * 0.5, 1.0 - s * 0.5);
        if (abs(subj.x - cx) + halfX + u_margin <= s * 0.5 &&
            abs(subj.y - cy) + halfY + u_margin <= s * 0.5) {
            wcx = cx; wcy = cy; ws = s;
            break;
        }
    }
    if (prev.z <= 0.0 || mode == MODE_SOLVE) { fragColor = vec4(wcx, wcy, ws, 0.0); return; }
    if (mode == MODE_HOLD) { fragColor = prev; return; }

    float d = length(vec2(wcx - prev.x, wcy - prev.y)) + abs(ws - prev.z);
    float moving = prev.w;
    if (d > u_deadband) moving = 1.0;
    else if (d < u_deadband * 0.3) moving = 0.0;
    if (moving < 0.5) { fragColor = vec4(prev.xyz, 0.0); return; }

    fragColor = vec4(
        mix(prev.x, wcx, u_ease),
        mix(prev.y, wcy, u_ease),
        mix(prev.z, ws,  u_ease),
        1.0
    );
}
\`;var Ut=class extends g{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch",[2,1]);i(this,"shader",ia);let s=this.makeTexture(null,2,1);this.output={h:1,w:1,c:8,texture:s,texW:2,texH:1},this.inputs=[t,a,o],this.samplers=[{name:"u_box",texture:t.texture},{name:"u_prev",texture:a.texture},{name:"u_cmd",texture:o.texture}],this.uniformInts={u_k:t.w*t.h},this.uniformFloats={u_zoom:n.zoom,u_gravity:n.gravity,u_margin:n.margin,u_deadband:n.deadband,u_ease:n.ease,u_aspect:n.aspect},this.defaultSetup()}};var sa=\`#version 300 es
// Apply the reframe crop: sample \\\`src\\\` through the view rect. Same shape in and
// out. See reframe.wgsl for why this sits after the effect chain and touches
// only the foreground + alpha (never the background).
//
// rect = (cx, cy, size, moving), frame fractions; size \\u2264 0 \\u2192 identity.

precision highp float;
precision highp int;

uniform sampler2D u_src;
uniform sampler2D u_rect;   // 1\\xD71
uniform int u_h;
uniform int u_w;

out vec4 fragColor;

vec4 samp(int x, int y) {
    return texelFetch(u_src, ivec2(clamp(x, 0, u_w - 1), clamp(y, 0, u_h - 1)), 0);
}

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    vec4 r = texelFetch(u_rect, ivec2(0, 0), 0);
    float s = r.z, rcx = r.x, rcy = r.y;
    if (s <= 0.0) { s = 1.0; rcx = 0.5; rcy = 0.5; }

    float fx = (rcx - s * 0.5) + ((float(x) + 0.5) / float(u_w)) * s;
    float fy = (rcy - s * 0.5) + ((float(y) + 0.5) / float(u_h)) * s;
    // fraction \\u2192 texel index; an identity rect lands exactly on texel centres,
    // making the op a bit-exact copy.
    float sx = fx * float(u_w) - 0.5;
    float sy = fy * float(u_h) - 0.5;

    int x0 = int(floor(sx));
    int y0 = int(floor(sy));
    float tx = sx - float(x0);
    float ty = sy - float(y0);

    vec4 top = mix(samp(x0, y0),     samp(x0 + 1, y0),     tx);
    vec4 bot = mix(samp(x0, y0 + 1), samp(x0 + 1, y0 + 1), tx);
    fragColor = mix(top, bot, ty);
}
\`;var Bt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",sa);let o=this.makeTexture(null,t.w,t.h);this.output={h:t.h,w:t.w,c:4,texture:o,texW:t.w,texH:t.h},this.inputs=[t,a],this.samplers=[{name:"u_src",texture:t.texture},{name:"u_rect",texture:a.texture}],this.uniformInts={u_h:t.h,u_w:t.w},this.defaultSetup(),this.dispatch=[t.w,t.h]}};var na=\`#version 300 es
// Box-driven square crop + bilinear resample + ((rgb - mean)/std) normalize.
// Reads the box tensor (face_box output: cx, cy, halfSide, score in frame
// fractions; halfSide as a fraction of frame WIDTH) and emits the landmark
// model's input, .w = 0. Sampling mirrors landmark training's warpAffine:
// src = center + (u - out/2) \\xB7 side/out.
//
// frame texture: (w, h) \\u2014 4-ch, 1 group. box texture: 1\\xD71.

precision highp float;
precision highp int;

uniform sampler2D u_frame;
uniform sampler2D u_box;
uniform int u_in_h;
uniform int u_in_w;
uniform int u_out_h;
uniform int u_out_w;
uniform int u_slot;   // box-tensor slot (multi-face); 0 for the single-face path
uniform float u_mean_r;
uniform float u_mean_g;
uniform float u_mean_b;
uniform float u_std_r;
uniform float u_std_g;
uniform float u_std_b;

out vec4 fragColor;

vec4 samp(int x, int y) {
    return texelFetch(u_frame, ivec2(clamp(x, 0, u_in_w - 1), clamp(y, 0, u_in_h - 1)), 0);
}

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    vec4 box = texelFetch(u_box, ivec2(u_slot, 0), 0);
    float cx   = box.x * float(u_in_w);
    float cy   = box.y * float(u_in_h);
    float side = 2.0 * box.z * float(u_in_w);

    float sx = clamp(cx + (float(x) - float(u_out_w) * 0.5) * side / float(u_out_w), 0.0, float(u_in_w - 1));
    float sy = clamp(cy + (float(y) - float(u_out_h) * 0.5) * side / float(u_out_h), 0.0, float(u_in_h - 1));

    int x0 = int(floor(sx));
    int y0 = int(floor(sy));
    float tx = sx - float(x0);
    float ty = sy - float(y0);

    vec4 top = mix(samp(x0, y0),     samp(x0 + 1, y0),     tx);
    vec4 bot = mix(samp(x0, y0 + 1), samp(x0 + 1, y0 + 1), tx);
    vec4 v = mix(top, bot, ty);

    vec3 mean = vec3(u_mean_r, u_mean_g, u_mean_b);
    vec3 std  = vec3(u_std_r, u_std_g, u_std_b);
    fragColor = vec4((v.rgb - mean) / std, 0.0);
}
\`;var St=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",na);let n=o.slot??0;if(n>=a.w*a.h)throw new Error(\`CropResample: slot \${n} out of range for a \${a.h}\\xD7\${a.w} box tensor\`);let s=this.makeTexture(null,o.outW,o.outH);this.output={h:o.outH,w:o.outW,c:4,texture:s,texW:o.outW,texH:o.outH},this.inputs=[t,a],this.samplers=[{name:"u_frame",texture:t.texture},{name:"u_box",texture:a.texture}],this.uniformInts={u_in_h:t.h,u_in_w:t.w,u_out_h:o.outH,u_out_w:o.outW,u_slot:n},this.uniformFloats={u_mean_r:o.mean[0],u_mean_g:o.mean[1],u_mean_b:o.mean[2],u_std_r:o.std[0],u_std_g:o.std[1],u_std_b:o.std[2]},this.defaultSetup(),this.dispatch=[o.outW,o.outH]}};var At=\`#version 300 es
// Passthrough "compositor": writes the image directly to the canvas
// (default framebuffer). No alpha math, no background. Used by RenderOp
// when the renderer is in disabled state.
//
// Caller invariants:
//   - canvas (viewport) === image h \\xD7 w (no resampling here)

precision highp float;

uniform sampler2D u_image;   // image as NHWC vec4 (RGBA)

out vec4 fragColor;

void main() {
    // WebGL gl_FragCoord origin is bottom-left; tensor textures are stored
    // top-down. Flip y so the displayed image is upright. (Matches what the
    // existing composite_solid.glsl does.)
    int H = textureSize(u_image, 0).y;
    ivec2 px = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));
    vec3  rgb = texelFetch(u_image, px, 0).rgb;
    fragColor = vec4(rgb, 1.0);
}
\`;var gn=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,_n=\`#version 300 es
precision highp float;
uniform sampler2D u_lm;
uniform sampler2D u_box;
uniform int u_slot;
uniform float u_thresh;
uniform float u_point_size;
uniform float u_canvas_w;
uniform float u_canvas_h;

void main() {
    int i = gl_VertexID;
    vec4 box = texelFetch(u_box, ivec2(u_slot, 0), 0);
    if (box.w < u_thresh) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // clipped away
        gl_PointSize = 0.0;
        return;
    }
    vec4 g = texelFetch(u_lm, ivec2(i / 2, 0), 0);
    float lx = g[(i % 2) * 2];
    float ly = g[(i % 2) * 2 + 1];

    float hsx = box.z;
    float hsy = box.z * u_canvas_w / u_canvas_h;
    float px = (box.x - hsx) + lx * 2.0 * hsx;
    float py = (box.y - hsy) + ly * 2.0 * hsy;

    gl_Position = vec4(px * 2.0 - 1.0, 1.0 - 2.0 * py, 0.0, 1.0);
    gl_PointSize = u_point_size;
}\`,bn=\`#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 fragColor;
void main() { fragColor = vec4(u_color, 1.0); }\`;function ua(u,e,r,t){let a=u.createShader(u.VERTEX_SHADER);if(u.shaderSource(a,e),u.compileShader(a),!u.getShaderParameter(a,u.COMPILE_STATUS))throw new Error(\`\${t} vert compile error: \${u.getShaderInfoLog(a)}\`);let o=u.createShader(u.FRAGMENT_SHADER);if(u.shaderSource(o,r),u.compileShader(o),!u.getShaderParameter(o,u.COMPILE_STATUS))throw new Error(\`\${t} frag compile error: \${u.getShaderInfoLog(o)}\`);let n=u.createProgram();if(u.attachShader(n,a),u.attachShader(n,o),u.linkProgram(n),!u.getProgramParameter(n,u.LINK_STATUS))throw new Error(\`\${t} link error: \${u.getProgramInfoLog(n)}\`);return n}var Lt=class{constructor(e,r,t,a,o){i(this,"backend",e);i(this,"imgProgram");i(this,"ptsProgram");i(this,"imageTex");i(this,"lmTex");i(this,"boxTex");i(this,"params");i(this,"canvasW");i(this,"canvasH");i(this,"slot");if(t.c<o.count*2)throw new Error(\`LandmarkOverlay: landmarks tensor holds \${t.c/2} points < count \${o.count}\`);if(this.slot=o.slot??0,this.slot>=a.w*a.h)throw new Error(\`LandmarkOverlay: slot \${this.slot} out of range for a \${a.h}\\xD7\${a.w} box tensor\`);this.imageTex=r.texture,this.lmTex=t.texture,this.boxTex=a.texture,this.params=o,this.canvasW=r.w,this.canvasH=r.h;let n=e.gl;this.imgProgram=ua(n,gn,At,"landmark_overlay img"),this.ptsProgram=ua(n,_n,bn,"landmark_overlay pts")}run(){let e=this.backend.gl;this.backend.bindDisplayFramebuffer(),e.bindVertexArray(null),(this.params.drawImage??!0)&&(e.useProgram(this.imgProgram),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.imageTex),e.uniform1i(e.getUniformLocation(this.imgProgram,"u_image"),0),e.drawArrays(e.TRIANGLES,0,6)),e.useProgram(this.ptsProgram),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.lmTex),e.uniform1i(e.getUniformLocation(this.ptsProgram,"u_lm"),0),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,this.boxTex),e.uniform1i(e.getUniformLocation(this.ptsProgram,"u_box"),1),e.uniform1i(e.getUniformLocation(this.ptsProgram,"u_slot"),this.slot),e.uniform1f(e.getUniformLocation(this.ptsProgram,"u_thresh"),this.params.thresh),e.uniform1f(e.getUniformLocation(this.ptsProgram,"u_point_size"),this.params.pointSize),e.uniform1f(e.getUniformLocation(this.ptsProgram,"u_canvas_w"),this.canvasW),e.uniform1f(e.getUniformLocation(this.ptsProgram,"u_canvas_h"),this.canvasH),e.uniform3f(e.getUniformLocation(this.ptsProgram,"u_color"),this.params.color[0],this.params.color[1],this.params.color[2]),e.drawArrays(e.POINTS,0,this.params.count)}};var Z=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,mr=\`
uniform sampler2D u_lm;
uniform sampler2D u_box;
uniform float u_thresh;
uniform float u_canvas_w;
uniform float u_canvas_h;
uniform int u_grid;

vec3 lmFrame(int i, int face) {
    vec4 box = texelFetch(u_box, ivec2(face, 0), 0);
    int gi = face * 478 + i;
    vec4 g = texelFetch(u_lm, ivec2(gi / 2, 0), 0);
    float lx = g[(gi % 2) * 2];
    float ly = g[(gi % 2) * 2 + 1];
    float hsx = box.z;
    float hsy = box.z * u_canvas_w / u_canvas_h;
    return vec3((box.x - hsx) + lx * 2.0 * hsx, (box.y - hsy) + ly * 2.0 * hsy, box.w);
}

// Face 'face' owns tile (face % grid, face / grid). grid=1 (K=1) -> the whole
// atlas, i.e. the single-face layout unchanged.
vec2 tileUv(vec2 uv, int face) {
    float g = float(u_grid);
    return (uv + vec2(float(face % u_grid), float(face / u_grid))) / g;
}\`,pa=\`#version 300 es
precision highp float;
layout(location = 0) in vec2 a_uv;
layout(location = 1) in float a_idx;
\${mr}
out vec2 v_src;
void main() {
    vec3 l = lmFrame(int(a_idx), gl_InstanceID);
    if (l.z < u_thresh) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    v_src = l.xy;
    gl_Position = vec4(tileUv(a_uv, gl_InstanceID) * 2.0 - 1.0, 0.0, 1.0);
}\`,ca=\`
uniform sampler2D u_frame;
uniform float u_frame_w;
uniform float u_frame_h;

vec3 frameAt(int x, int y) {
    return texelFetch(u_frame, ivec2(clamp(x, 0, int(u_frame_w) - 1), clamp(y, 0, int(u_frame_h) - 1)), 0).rgb;
}
vec3 frameBilinear(vec2 f) {
    float sx = clamp(f.x * u_frame_w - 0.5, 0.0, u_frame_w - 1.0);
    float sy = clamp(f.y * u_frame_h - 0.5, 0.0, u_frame_h - 1.0);
    int x0 = int(floor(sx));
    int y0 = int(floor(sy));
    float tx = sx - float(x0);
    float ty = sy - float(y0);
    vec3 top = mix(frameAt(x0, y0),     frameAt(x0 + 1, y0),     tx);
    vec3 bot = mix(frameAt(x0, y0 + 1), frameAt(x0 + 1, y0 + 1), tx);
    return mix(top, bot, ty);
}\`,la=\`#version 300 es
precision highp float;
precision highp int;
in vec2 v_src;
\${ca}
out vec4 fragColor;
void main() { fragColor = vec4(frameBilinear(v_src), 1.0); }\`,fa=\`#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_grid;
// The tile containing 'uv', as (lo.xy, hi.zw) - filter taps clamp to it so one
// face's skin can't bleed into a neighbour's tile.
vec4 tileBounds(vec2 uv) {
    float g = float(u_grid);
    vec2 t = floor(clamp(uv, vec2(0.0), vec2(0.99999)) * g);
    return vec4(t / g, (t + vec2(1.0)) / g);
}
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / 512.0;
    vec4 tb = tileBounds(uv);
    float ht = 0.5 / 512.0;
    vec2 lo = tb.xy + ht, hi = tb.zw - ht;
    float s = max(u_sigma, 0.001);
    int R = int(clamp(ceil(s * 2.5), 1.0, 48.0));
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int i = -48; i <= 48; i++) {
        if (i < -R || i > R) continue;
        float w = exp(-float(i * i) / (2.0 * s * s));
        sum += texture(u_tex, clamp(uv + u_dir * float(i), lo, hi)) * w;
        wsum += w;
    }
    fragColor = sum / wsum;
}\`,da=\`#version 300 es
precision highp float;
uniform sampler2D u_atlas;
uniform sampler2D u_low;
uniform float u_detail;
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / 512.0;
    vec4 a  = texture(u_atlas, uv);
    vec4 lo = texture(u_low, uv);
    fragColor = clamp(lo + (a - lo) * u_detail, 0.0, 1.0);
}\`,ma=\`#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_sigma;
uniform int u_grid;
vec4 tileBounds(vec2 uv) {
    float g = float(u_grid);
    vec2 t = floor(clamp(uv, vec2(0.0), vec2(0.99999)) * g);
    return vec4(t / g, (t + vec2(1.0)) / g);
}
out vec4 fragColor;
void main() {
    vec2 uv = gl_FragCoord.xy / 512.0;
    vec2 texel = vec2(1.0 / 512.0);
    vec4 tb = tileBounds(uv);
    vec2 blo = tb.xy + texel * 0.5, bhi = tb.zw - texel * 0.5;
    float ss = max(u_sigma, 0.001);
    int R = int(clamp(ceil(ss), 1.0, 12.0));
    float sr = 0.15;
    vec3 c = texture(u_tex, uv).rgb;
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int y = -12; y <= 12; y++) {
        if (y < -R || y > R) continue;
        for (int x = -12; x <= 12; x++) {
            if (x < -R || x > R) continue;
            vec3 sc = texture(u_tex, clamp(uv + texel * vec2(float(x), float(y)), blo, bhi)).rgb;
            float ws = exp(-float(x * x + y * y) / (2.0 * ss * ss));
            vec3 d = sc - c;
            float wr = exp(-dot(d, d) / (2.0 * sr * sr));
            sum += sc * ws * wr;
            wsum += ws * wr;
        }
    }
    fragColor = vec4(sum / wsum, 1.0);
}\`,vn=\`#version 300 es
precision highp float;
uniform sampler2D u_image;
out vec4 fragColor;
void main() {
    int H = textureSize(u_image, 0).y;
    ivec2 px = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));
    fragColor = vec4(texelFetch(u_image, px, 0).rgb, 1.0);
}\`,xn=\`#version 300 es
precision highp float;
layout(location = 0) in vec2 a_uv;
layout(location = 1) in float a_idx;
\${mr}
out vec2 v_uv;        // TILED atlas uv \\u2014 the atlas is per-face
out vec2 v_uv_mask;   // UNTILED canonical uv \\u2014 the weight mask is one shared asset
out vec2 v_src;
void main() {
    vec3 l = lmFrame(int(a_idx), gl_InstanceID);
    if (l.z < u_thresh) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    v_uv = tileUv(a_uv, gl_InstanceID);
    v_uv_mask = a_uv;
    v_src = l.xy;
    gl_Position = vec4(l.x * 2.0 - 1.0, 1.0 - 2.0 * l.y, 0.0, 1.0);
}\`,ha=\`#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
in vec2 v_uv_mask;
in vec2 v_src;
uniform sampler2D u_smoothed;
uniform sampler2D u_weight;
uniform float u_strength;
\${ca}
out vec4 fragColor;
void main() {
    vec3 orig = frameBilinear(v_src);
    vec3 sm   = texture(u_smoothed, v_uv).rgb;
    // v_uv_mask, not v_uv: the atlas is tiled per face, the weight mask is one
    // shared canonical asset. See face_touchup.wgsl fs_comp.
    float w   = texture(u_weight, v_uv_mask).r * u_strength;
    fragColor = vec4(mix(orig, sm, w), 1.0);
}\`;function N(u,e,r,t){let a=(n,s,p)=>{let c=u.createShader(n);if(u.shaderSource(c,s),u.compileShader(c),!u.getShaderParameter(c,u.COMPILE_STATUS))throw new Error(\`\${t} \${p} compile error: \${u.getShaderInfoLog(c)}\`);return c},o=u.createProgram();if(u.attachShader(o,a(u.VERTEX_SHADER,e,"vert")),u.attachShader(o,a(u.FRAGMENT_SHADER,r,"frag")),u.linkProgram(o),!u.getProgramParameter(o,u.LINK_STATUS))throw new Error(\`\${t} link error: \${u.getProgramInfoLog(o)}\`);return o}var Ft=class{constructor(e,r,t,a,o,n){i(this,"backend",e);i(this,"progs");i(this,"meshVao");i(this,"fbo");i(this,"atlas");i(this,"ping");i(this,"low");i(this,"smoothed");i(this,"weight");i(this,"frame");i(this,"lm");i(this,"box");i(this,"count");i(this,"params");i(this,"slots");i(this,"grid");i(this,"activeSlots");let s=e.gl;if(this.frame=r,this.lm=t,this.box=a,this.count=o.count,this.params=n,this.slots=n.slots??1,this.slots!==1&&this.slots!==4)throw new Error(\`FaceTouchup: slots must be 1 or 4, got \${this.slots}\`);if(this.grid=this.slots===4?2:1,this.activeSlots=this.slots,a.w*a.h<this.slots)throw new Error(\`FaceTouchup: slots \${this.slots} exceeds the \${a.h}\\xD7\${a.w} box tensor\`);if(t.c<this.slots*956)throw new Error(\`FaceTouchup: landmarks tensor holds \${t.c/956} faces < slots \${this.slots}\`);this.progs={unwrap:N(s,pa,la,"touchup unwrap"),blur:N(s,Z,fa,"touchup blur"),combine:N(s,Z,da,"touchup combine"),bilateral:N(s,Z,ma,"touchup bilateral"),blit:N(s,Z,vn,"touchup blit"),comp:N(s,xn,ha,"touchup comp")},this.meshVao=s.createVertexArray(),s.bindVertexArray(this.meshVao);let p=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,p),s.bufferData(s.ARRAY_BUFFER,o.uv,s.STATIC_DRAW),s.enableVertexAttribArray(0),s.vertexAttribPointer(0,2,s.FLOAT,!1,0,0);let c=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,c),s.bufferData(s.ARRAY_BUFFER,o.idx,s.STATIC_DRAW),s.enableVertexAttribArray(1),s.vertexAttribPointer(1,1,s.FLOAT,!1,0,0),s.bindVertexArray(null);let l=f=>{let d=s.createTexture();return s.bindTexture(s.TEXTURE_2D,d),f?s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,s.RGBA,s.UNSIGNED_BYTE,f):s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,512,512,0,s.RGBA,s.UNSIGNED_BYTE,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),d};this.atlas=l(null),this.ping=l(null),this.low=l(null),this.smoothed=l(null),this.weight=l(o.weightMask),this.fbo=s.createFramebuffer()}bindTex(e,r,t,a){let o=this.backend.gl;o.activeTexture(o.TEXTURE0+r),o.bindTexture(o.TEXTURE_2D,a),o.uniform1i(o.getUniformLocation(e,t),r)}lmUniforms(e){let r=this.backend.gl;this.bindTex(e,4,"u_lm",this.lm.texture),this.bindTex(e,5,"u_box",this.box.texture),r.uniform1f(r.getUniformLocation(e,"u_thresh"),this.params.thresh),r.uniform1f(r.getUniformLocation(e,"u_canvas_w"),this.frame.w),r.uniform1f(r.getUniformLocation(e,"u_canvas_h"),this.frame.h),r.uniform1i(r.getUniformLocation(e,"u_grid"),this.grid)}frameUniforms(e){let r=this.backend.gl;this.bindTex(e,0,"u_frame",this.frame.texture),r.uniform1f(r.getUniformLocation(e,"u_frame_w"),this.frame.w),r.uniform1f(r.getUniformLocation(e,"u_frame_h"),this.frame.h)}atlasPass(e,r){let t=this.backend.gl;t.bindFramebuffer(t.FRAMEBUFFER,this.fbo),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,e,0),t.viewport(0,0,512,512),r()}run(){let e=this.backend.gl;if(this.atlasPass(this.atlas,()=>{e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.useProgram(this.progs.unwrap),this.frameUniforms(this.progs.unwrap),this.lmUniforms(this.progs.unwrap),e.bindVertexArray(this.meshVao),e.drawArraysInstanced(e.TRIANGLES,0,this.count,this.activeSlots),e.bindVertexArray(null)}),(this.params.style??"freq-sep")==="bilateral")this.atlasPass(this.smoothed,()=>{e.useProgram(this.progs.bilateral),this.bindTex(this.progs.bilateral,0,"u_tex",this.atlas),e.uniform1f(e.getUniformLocation(this.progs.bilateral,"u_sigma"),this.params.amount),e.uniform1i(e.getUniformLocation(this.progs.bilateral,"u_grid"),this.grid),e.drawArrays(e.TRIANGLES,0,6)});else{let r=(t,a,o,n)=>this.atlasPass(a,()=>{e.useProgram(this.progs.blur),this.bindTex(this.progs.blur,0,"u_tex",t),e.uniform2f(e.getUniformLocation(this.progs.blur,"u_dir"),o,n),e.uniform1f(e.getUniformLocation(this.progs.blur,"u_sigma"),this.params.amount),e.uniform1i(e.getUniformLocation(this.progs.blur,"u_grid"),this.grid),e.drawArrays(e.TRIANGLES,0,6)});r(this.atlas,this.ping,1/512,0),r(this.ping,this.low,0,1/512),this.atlasPass(this.smoothed,()=>{e.useProgram(this.progs.combine),this.bindTex(this.progs.combine,0,"u_atlas",this.atlas),this.bindTex(this.progs.combine,1,"u_low",this.low),e.uniform1f(e.getUniformLocation(this.progs.combine,"u_detail"),this.params.detail),e.drawArrays(e.TRIANGLES,0,6)})}this.backend.bindDisplayFramebuffer(),e.viewport(0,0,this.frame.w,this.frame.h),e.useProgram(this.progs.blit),this.bindTex(this.progs.blit,0,"u_image",this.frame.texture),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6),e.useProgram(this.progs.comp),this.frameUniforms(this.progs.comp),this.lmUniforms(this.progs.comp),this.bindTex(this.progs.comp,1,"u_smoothed",this.smoothed),this.bindTex(this.progs.comp,2,"u_weight",this.weight),e.uniform1f(e.getUniformLocation(this.progs.comp,"u_strength"),this.params.strength),e.bindVertexArray(this.meshVao),e.drawArraysInstanced(e.TRIANGLES,0,this.count,this.activeSlots),e.bindVertexArray(null)}},yn=\`#version 300 es
precision highp float;
uniform sampler2D u_image;
out vec4 fragColor;
void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    fragColor = vec4(texelFetch(u_image, px, 0).rgb, 1.0);
}\`,wn=\`#version 300 es
precision highp float;
layout(location = 0) in vec2 a_uv;
layout(location = 1) in float a_idx;
\${mr}
out vec2 v_uv;        // TILED atlas uv \\u2014 the atlas is per-face
out vec2 v_uv_mask;   // UNTILED canonical uv \\u2014 the weight mask is one shared asset
out vec2 v_src;
void main() {
    vec3 l = lmFrame(int(a_idx), gl_InstanceID);
    if (l.z < u_thresh) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    v_uv = tileUv(a_uv, gl_InstanceID);
    v_uv_mask = a_uv;
    v_src = l.xy;
    gl_Position = vec4(l.x * 2.0 - 1.0, l.y * 2.0 - 1.0, 0.0, 1.0);
}\`,Et=class{constructor(e,r,t,a,o,n){i(this,"backend",e);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"progs");i(this,"meshVao");i(this,"fbo");i(this,"atlas");i(this,"ping");i(this,"low");i(this,"smoothed");i(this,"weightTex");i(this,"frame");i(this,"lm");i(this,"box");i(this,"count");i(this,"params");i(this,"slots");i(this,"grid");i(this,"activeSlots");let s=e.gl;if(this.inputs=[r,t,a],this.frame=r,this.lm=t,this.box=a,this.count=o.count,this.params=n,this.slots=n.slots??1,this.slots!==1&&this.slots!==4)throw new Error(\`FaceTouchup: slots must be 1 or 4, got \${this.slots}\`);if(this.grid=this.slots===4?2:1,this.activeSlots=this.slots,a.w*a.h<this.slots)throw new Error(\`FaceTouchup: slots \${this.slots} exceeds the \${a.h}\\xD7\${a.w} box tensor\`);if(t.c<this.slots*956)throw new Error(\`FaceTouchup: landmarks tensor holds \${t.c/956} faces < slots \${this.slots}\`);this.output=e.tensor(r.h,r.w,4),this.progs={unwrap:N(s,pa,la,"touchup-stage unwrap"),blur:N(s,Z,fa,"touchup-stage blur"),combine:N(s,Z,da,"touchup-stage combine"),bilateral:N(s,Z,ma,"touchup-stage bilateral"),blitT:N(s,Z,yn,"touchup-stage blitT"),compT:N(s,wn,ha,"touchup-stage compT")},this.meshVao=s.createVertexArray(),s.bindVertexArray(this.meshVao);let p=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,p),s.bufferData(s.ARRAY_BUFFER,o.uv,s.STATIC_DRAW),s.enableVertexAttribArray(0),s.vertexAttribPointer(0,2,s.FLOAT,!1,0,0);let c=s.createBuffer();s.bindBuffer(s.ARRAY_BUFFER,c),s.bufferData(s.ARRAY_BUFFER,o.idx,s.STATIC_DRAW),s.enableVertexAttribArray(1),s.vertexAttribPointer(1,1,s.FLOAT,!1,0,0),s.bindVertexArray(null);let l=f=>{let d=s.createTexture();return s.bindTexture(s.TEXTURE_2D,d),f?s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,s.RGBA,s.UNSIGNED_BYTE,f):s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,512,512,0,s.RGBA,s.UNSIGNED_BYTE,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.LINEAR),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),d};this.atlas=l(null),this.ping=l(null),this.low=l(null),this.smoothed=l(null),this.weightTex=l(o.weightMask),this.fbo=s.createFramebuffer()}bindTex(e,r,t,a){let o=this.backend.gl;o.activeTexture(o.TEXTURE0+r),o.bindTexture(o.TEXTURE_2D,a),o.uniform1i(o.getUniformLocation(e,t),r)}lmUniforms(e){let r=this.backend.gl;this.bindTex(e,4,"u_lm",this.lm.texture),this.bindTex(e,5,"u_box",this.box.texture),r.uniform1f(r.getUniformLocation(e,"u_thresh"),this.params.thresh),r.uniform1f(r.getUniformLocation(e,"u_canvas_w"),this.frame.w),r.uniform1f(r.getUniformLocation(e,"u_canvas_h"),this.frame.h),r.uniform1i(r.getUniformLocation(e,"u_grid"),this.grid)}frameUniforms(e){let r=this.backend.gl;this.bindTex(e,0,"u_frame",this.frame.texture),r.uniform1f(r.getUniformLocation(e,"u_frame_w"),this.frame.w),r.uniform1f(r.getUniformLocation(e,"u_frame_h"),this.frame.h)}pass(e,r,t,a){let o=this.backend.gl;o.bindFramebuffer(o.FRAMEBUFFER,this.fbo),o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0,o.TEXTURE_2D,e,0),o.viewport(0,0,r,t),a()}setActiveSlots(e){this.activeSlots=Math.max(0,Math.min(e,this.slots))}run(){let e=this.backend.gl;if(this.pass(this.atlas,512,512,()=>{e.clearColor(0,0,0,0),e.clear(e.COLOR_BUFFER_BIT),e.useProgram(this.progs.unwrap),this.frameUniforms(this.progs.unwrap),this.lmUniforms(this.progs.unwrap),e.bindVertexArray(this.meshVao),e.drawArraysInstanced(e.TRIANGLES,0,this.count,this.activeSlots),e.bindVertexArray(null)}),(this.params.style??"freq-sep")==="bilateral")this.pass(this.smoothed,512,512,()=>{e.useProgram(this.progs.bilateral),this.bindTex(this.progs.bilateral,0,"u_tex",this.atlas),e.uniform1f(e.getUniformLocation(this.progs.bilateral,"u_sigma"),this.params.amount),e.uniform1i(e.getUniformLocation(this.progs.bilateral,"u_grid"),this.grid),e.drawArrays(e.TRIANGLES,0,6)});else{let r=(t,a,o,n)=>this.pass(a,512,512,()=>{e.useProgram(this.progs.blur),this.bindTex(this.progs.blur,0,"u_tex",t),e.uniform2f(e.getUniformLocation(this.progs.blur,"u_dir"),o,n),e.uniform1f(e.getUniformLocation(this.progs.blur,"u_sigma"),this.params.amount),e.uniform1i(e.getUniformLocation(this.progs.blur,"u_grid"),this.grid),e.drawArrays(e.TRIANGLES,0,6)});r(this.atlas,this.ping,1/512,0),r(this.ping,this.low,0,1/512),this.pass(this.smoothed,512,512,()=>{e.useProgram(this.progs.combine),this.bindTex(this.progs.combine,0,"u_atlas",this.atlas),this.bindTex(this.progs.combine,1,"u_low",this.low),e.uniform1f(e.getUniformLocation(this.progs.combine,"u_detail"),this.params.detail),e.drawArrays(e.TRIANGLES,0,6)})}this.pass(this.output.texture,this.frame.w,this.frame.h,()=>{e.useProgram(this.progs.blitT),this.bindTex(this.progs.blitT,0,"u_image",this.frame.texture),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6),e.useProgram(this.progs.compT),this.frameUniforms(this.progs.compT),this.lmUniforms(this.progs.compT),this.bindTex(this.progs.compT,1,"u_smoothed",this.smoothed),this.bindTex(this.progs.compT,2,"u_weight",this.weightTex),e.uniform1f(e.getUniformLocation(this.progs.compT,"u_strength"),this.params.strength),e.bindVertexArray(this.meshVao),e.drawArraysInstanced(e.TRIANGLES,0,this.count,this.activeSlots),e.bindVertexArray(null)})}};var ga=\`#version 300 es
// Flow-gated temporal stabilizer. Per pixel:
//   env = max(|flow.xy|, release\\xB7envPrev.y)   peak-hold
//   g   = max(clamp((env - tLo)/(tHi - tLo), 0, 1), leak)
//   out = vec4((g\\xB7pred + (1-g)\\xB7ref).x, env, 0, 0)

precision highp float;
precision highp int;

uniform sampler2D u_flow;
uniform sampler2D u_pred;
uniform sampler2D u_ref;
uniform sampler2D u_env_prev;
uniform int   u_w;
uniform int   u_h;
uniform float u_t_lo;
uniform float u_t_hi;
uniform float u_leak;
uniform float u_release;
uniform float u_t_div;
uniform float u_div_scale;
uniform int   u_step_x;
uniform int   u_step_y;

out vec4 fragColor;

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    float mag     = length(texelFetch(u_flow, ivec2(x, y), 0).xy);
    float envPrev = texelFetch(u_env_prev, ivec2(x, y), 0).y;
    float env     = max(mag, u_release * envPrev);

    // Flow divergence over a \\xB1step finite-difference (clamped to the edges).
    int xr = min(x + u_step_x, u_w - 1);
    int xl = max(x - u_step_x, 0);
    int yd = min(y + u_step_y, u_h - 1);
    int yu = max(y - u_step_y, 0);
    float dfx = texelFetch(u_flow, ivec2(xr, y), 0).x - texelFetch(u_flow, ivec2(xl, y), 0).x;
    float dfy = texelFetch(u_flow, ivec2(x, yd), 0).y - texelFetch(u_flow, ivec2(x, yu), 0).y;
    float divg = abs(dfx + dfy);

    float gMag = clamp((env - u_t_lo) / max(u_t_hi - u_t_lo, 1e-3), 0.0, 1.0);
    float gDiv = clamp((divg - u_t_div) / max(u_div_scale, 1e-3), 0.0, 1.0);
    float g = max(max(gMag, gDiv), u_leak);

    float pred = texelFetch(u_pred, ivec2(x, y), 0).x;
    float refv = texelFetch(u_ref,  ivec2(x, y), 0).x;
    float stab = g * pred + (1.0 - g) * refv;

    fragColor = vec4(stab, env, 0.0, 0.0);
}
\`;var Rt=class extends g{constructor(r,t,a,o,n,s){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",ga);let p=t.w,c=t.h,l=this.makeTexture(null,p,c);this.output={h:c,w:p,c:4,texture:l,texW:p,texH:c},this.inputs=[t,a,o,n],this.samplers=[{name:"u_flow",texture:t.texture},{name:"u_pred",texture:a.texture},{name:"u_ref",texture:o.texture},{name:"u_env_prev",texture:n.texture}],this.uniformInts={u_w:p,u_h:c,u_step_x:s.stepX,u_step_y:s.stepY},this.uniformFloats={u_t_lo:s.tLo,u_t_hi:s.tHi,u_leak:s.leak,u_release:s.release,u_t_div:s.tDiv,u_div_scale:s.divScale},this.defaultSetup(),this.dispatch=[p,c]}};var _a=\`#version 300 es
// Bilinear upsample (arbitrary scale) \\u2014 align_corners=False.
//
// Hardware texture filtering can't be used: adjacent texels in x belong to
// different channel groups, not spatial neighbours. Manual 4-tap blend.
//
// Input:  (in_W  * c_groups, in_H)
// Output: (out_W * c_groups, out_H)

precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform int u_in_w;
uniform int u_in_h;
uniform int u_out_w;
uniform int u_out_h;
uniform int u_c_groups;

out vec4 fragColor;

void main() {
    ivec2 fc    = ivec2(gl_FragCoord.xy);
    int x_out   = fc.x / u_c_groups;
    int y_out   = fc.y;
    int c_group = fc.x - x_out * u_c_groups;

    float scale_x = float(u_in_w) / float(u_out_w);
    float scale_y = float(u_in_h) / float(u_out_h);
    float src_x = (float(x_out) + 0.5) * scale_x - 0.5;
    float src_y = (float(y_out) + 0.5) * scale_y - 0.5;

    int x0 = int(floor(src_x));
    int y0 = int(floor(src_y));
    int x1 = x0 + 1;
    int y1 = y0 + 1;
    float fx = src_x - float(x0);
    float fy = src_y - float(y0);

    x0 = clamp(x0, 0, u_in_w - 1);
    y0 = clamp(y0, 0, u_in_h - 1);
    x1 = clamp(x1, 0, u_in_w - 1);
    y1 = clamp(y1, 0, u_in_h - 1);

    vec4 v00 = texelFetch(u_input, ivec2(x0 * u_c_groups + c_group, y0), 0);
    vec4 v10 = texelFetch(u_input, ivec2(x1 * u_c_groups + c_group, y0), 0);
    vec4 v01 = texelFetch(u_input, ivec2(x0 * u_c_groups + c_group, y1), 0);
    vec4 v11 = texelFetch(u_input, ivec2(x1 * u_c_groups + c_group, y1), 0);

    fragColor = mix(mix(v00, v10, fx), mix(v01, v11, fx), fy);
}
\`;var Dt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",_a);let o=t.c/4,n=a.outW*o,s=this.makeTexture(null,n,a.outH);this.output={h:a.outH,w:a.outW,c:t.c,texture:s,texW:n,texH:a.outH},this.inputs=[t],this.samplers=[{name:"u_input",texture:t.texture}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_out_w:a.outW,u_out_h:a.outH,u_c_groups:o},this.defaultSetup(),this.dispatch=[n,a.outH]}};var ba=\`#version 300 es
// Top-left crop: the output viewport is smaller than the input texture, so reading
// the same fragment coord yields the top-left subregion (channel groups packed in
// the x axis line up because group count is unchanged).

precision highp float;
precision highp int;

uniform sampler2D u_input;
out vec4 fragColor;

void main() {
    fragColor = texelFetch(u_input, ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y)), 0);
}
\`;var Ot=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",ba);let o=t.c/4,n=a.outW*o,s=this.makeTexture(null,n,a.outH);this.output={h:a.outH,w:a.outW,c:t.c,texture:s,texW:n,texH:a.outH},this.inputs=[t],this.samplers=[{name:"u_input",texture:t.texture}],this.defaultSetup(),this.dispatch=[n,a.outH]}};var va=\`#version 300 es
// Bicubic upsample (arbitrary scale) \\u2014 Keys cubic, a=-0.75 (PyTorch default
// for mode='bicubic', align_corners=False).
//
// Direct 2D, 4\\xD74 = 16 taps per output pixel. Hardware texture filtering
// can't be used (NHWC vec4 layout means adjacent texels in x belong to
// different channel groups, not spatial neighbours).

precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform int u_in_w;
uniform int u_in_h;
uniform int u_out_w;
uniform int u_out_h;
uniform int u_c_groups;

const float A = -0.75;

float wcubic(float d) {
    float ad = abs(d);
    if (ad <= 1.0) return ((A + 2.0) * ad - (A + 3.0)) * ad * ad + 1.0;
    if (ad <  2.0) return ((A * ad - 5.0 * A) * ad + 8.0 * A) * ad - 4.0 * A;
    return 0.0;
}

out vec4 fragColor;

void main() {
    ivec2 fc    = ivec2(gl_FragCoord.xy);
    int x_out   = fc.x / u_c_groups;
    int y_out   = fc.y;
    int c_group = fc.x - x_out * u_c_groups;

    float src_x = (float(x_out) + 0.5) * float(u_in_w) / float(u_out_w) - 0.5;
    float src_y = (float(y_out) + 0.5) * float(u_in_h) / float(u_out_h) - 0.5;

    int   x0 = int(floor(src_x));
    int   y0 = int(floor(src_y));
    float fx = src_x - float(x0);
    float fy = src_y - float(y0);

    // Weights for offsets {-1, 0, 1, 2} from x0/y0.
    float wx[4];
    float wy[4];
    wx[0] = wcubic(1.0 + fx); wx[1] = wcubic(fx);       wx[2] = wcubic(1.0 - fx); wx[3] = wcubic(2.0 - fx);
    wy[0] = wcubic(1.0 + fy); wy[1] = wcubic(fy);       wy[2] = wcubic(1.0 - fy); wy[3] = wcubic(2.0 - fy);

    vec4 acc = vec4(0.0);
    for (int j = 0; j < 4; j++) {
        int sy = clamp(y0 + j - 1, 0, u_in_h - 1);
        for (int i = 0; i < 4; i++) {
            int sx = clamp(x0 + i - 1, 0, u_in_w - 1);
            vec4 v = texelFetch(u_input, ivec2(sx * u_c_groups + c_group, sy), 0);
            acc += (wx[i] * wy[j]) * v;
        }
    }
    fragColor = acc;
}
\`;var It=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",va);let o=t.c/4,n=a.outW*o,s=this.makeTexture(null,n,a.outH);this.output={h:a.outH,w:a.outW,c:t.c,texture:s,texW:n,texH:a.outH},this.inputs=[t],this.samplers=[{name:"u_input",texture:t.texture}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_out_w:a.outW,u_out_h:a.outH,u_c_groups:o},this.defaultSetup(),this.dispatch=[n,a.outH]}};var xa=\`#version 300 es
// Channel concat \\u2014 concatenates two NHWC textures along the channel dimension.
// Both inputs must share the same spatial dimensions (W, H). Channel counts are
// multiples of 4 so each "group" is one vec4 texel.
//
// Input  A: (W * a_c_groups, H)
// Input  B: (W * b_c_groups, H)
// Output:   (W * (a_c_groups + b_c_groups), H)

precision highp float;
precision highp int;

uniform sampler2D u_input_a;
uniform sampler2D u_input_b;
uniform int u_a_c_groups;
uniform int u_b_c_groups;

out vec4 fragColor;

void main() {
    ivec2 fc       = ivec2(gl_FragCoord.xy);
    int out_groups = u_a_c_groups + u_b_c_groups;
    int x_spatial  = fc.x / out_groups;
    int c_out      = fc.x - x_spatial * out_groups;
    int y          = fc.y;

    if (c_out < u_a_c_groups) {
        fragColor = texelFetch(u_input_a, ivec2(x_spatial * u_a_c_groups + c_out, y), 0);
    } else {
        int c_b = c_out - u_a_c_groups;
        fragColor = texelFetch(u_input_b, ivec2(x_spatial * u_b_c_groups + c_b, y), 0);
    }
}
\`;var Mt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",xa);let o=t.c/4,n=a.c/4,s=o+n,p=t.c+a.c,c=t.w*s,l=this.makeTexture(null,c,t.h);this.output={h:t.h,w:t.w,c:p,texture:l,texW:c,texH:t.h},this.inputs=[t,a],this.samplers=[{name:"u_input_a",texture:t.texture},{name:"u_input_b",texture:a.texture}],this.uniformInts={u_a_c_groups:o,u_b_c_groups:n},this.defaultSetup(),this.dispatch=[c,t.h]}};var ya=\`#version 300 es
// Bilinear upsample + sigmoid fused \\u2014 sigmoid applied at write time, no intermediate buffer.
// See bilinear_upsample.glsl for the manual 4-tap blend rationale.
//
// Input:  (in_W  * c_groups, in_H)
// Output: (out_W * c_groups, out_H)

precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform int u_in_w;
uniform int u_in_h;
uniform int u_out_w;
uniform int u_out_h;
uniform int u_c_groups;

out vec4 fragColor;

void main() {
    ivec2 fc    = ivec2(gl_FragCoord.xy);
    int x_out   = fc.x / u_c_groups;
    int y_out   = fc.y;
    int c_group = fc.x - x_out * u_c_groups;

    float scale_x = float(u_in_w) / float(u_out_w);
    float scale_y = float(u_in_h) / float(u_out_h);
    float src_x = (float(x_out) + 0.5) * scale_x - 0.5;
    float src_y = (float(y_out) + 0.5) * scale_y - 0.5;

    int x0 = int(floor(src_x));
    int y0 = int(floor(src_y));
    int x1 = x0 + 1;
    int y1 = y0 + 1;
    float fx = src_x - float(x0);
    float fy = src_y - float(y0);

    x0 = clamp(x0, 0, u_in_w - 1);
    y0 = clamp(y0, 0, u_in_h - 1);
    x1 = clamp(x1, 0, u_in_w - 1);
    y1 = clamp(y1, 0, u_in_h - 1);

    vec4 v00 = texelFetch(u_input, ivec2(x0 * u_c_groups + c_group, y0), 0);
    vec4 v10 = texelFetch(u_input, ivec2(x1 * u_c_groups + c_group, y0), 0);
    vec4 v01 = texelFetch(u_input, ivec2(x0 * u_c_groups + c_group, y1), 0);
    vec4 v11 = texelFetch(u_input, ivec2(x1 * u_c_groups + c_group, y1), 0);

    vec4 result = mix(mix(v00, v10, fx), mix(v01, v11, fx), fy);
    fragColor = 1.0 / (1.0 + exp(-result));
}
\`;var zt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",ya);let o=t.c/4,n=a.outW*o,s=this.makeTexture(null,n,a.outH);this.output={h:a.outH,w:a.outW,c:t.c,texture:s,texW:n,texH:a.outH},this.inputs=[t],this.samplers=[{name:"u_input",texture:t.texture}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_out_w:a.outW,u_out_h:a.outH,u_c_groups:o},this.defaultSetup(),this.dispatch=[n,a.outH]}};var wa=\`#version 300 es
// Bilinear upsample (input_a) + channel concat (with input_b) fused.
// input_a is the decoder tensor at small spatial res (in_h \\xD7 in_w), bilinearly resized to (out_h \\xD7 out_w).
// input_b is the encoder skip feature already at output resolution.
// Output channels [0..a_groups-1] come from upsampled input_a.
// Output channels [a_groups..out_groups-1] come from input_b (passthrough).

precision highp float;
precision highp int;

uniform sampler2D u_input_a;
uniform sampler2D u_input_b;
uniform int u_in_w;
uniform int u_in_h;
uniform int u_out_w;
uniform int u_out_h;
uniform int u_a_c_groups;
uniform int u_b_c_groups;

out vec4 fragColor;

void main() {
    ivec2 fc       = ivec2(gl_FragCoord.xy);
    int out_groups = u_a_c_groups + u_b_c_groups;
    int x_out      = fc.x / out_groups;
    int c_out      = fc.x - x_out * out_groups;
    int y_out      = fc.y;

    if (c_out < u_a_c_groups) {
        // Bilinear sample from input_a at (x_out, y_out) for channel group c_out.
        float scale_x = float(u_in_w) / float(u_out_w);
        float scale_y = float(u_in_h) / float(u_out_h);
        float src_x = (float(x_out) + 0.5) * scale_x - 0.5;
        float src_y = (float(y_out) + 0.5) * scale_y - 0.5;

        int x0 = int(floor(src_x));
        int y0 = int(floor(src_y));
        int x1 = x0 + 1;
        int y1 = y0 + 1;
        float fx = src_x - float(x0);
        float fy = src_y - float(y0);

        x0 = clamp(x0, 0, u_in_w - 1);
        y0 = clamp(y0, 0, u_in_h - 1);
        x1 = clamp(x1, 0, u_in_w - 1);
        y1 = clamp(y1, 0, u_in_h - 1);

        vec4 v00 = texelFetch(u_input_a, ivec2(x0 * u_a_c_groups + c_out, y0), 0);
        vec4 v10 = texelFetch(u_input_a, ivec2(x1 * u_a_c_groups + c_out, y0), 0);
        vec4 v01 = texelFetch(u_input_a, ivec2(x0 * u_a_c_groups + c_out, y1), 0);
        vec4 v11 = texelFetch(u_input_a, ivec2(x1 * u_a_c_groups + c_out, y1), 0);

        fragColor = mix(mix(v00, v10, fx), mix(v01, v11, fx), fy);
    } else {
        int c_b = c_out - u_a_c_groups;
        fragColor = texelFetch(u_input_b, ivec2(x_out * u_b_c_groups + c_b, y_out), 0);
    }
}
\`;var Ht=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights",[]);i(this,"output");i(this,"dispatch");i(this,"shader",wa);let n=t.c/4,s=a.c/4,p=n+s,c=t.c+a.c,l=o.outW*p,f=this.makeTexture(null,l,o.outH);this.output={h:o.outH,w:o.outW,c,texture:f,texW:l,texH:o.outH},this.inputs=[t,a],this.samplers=[{name:"u_input_a",texture:t.texture},{name:"u_input_b",texture:a.texture}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_out_w:o.outW,u_out_h:o.outH,u_a_c_groups:n,u_b_c_groups:s},this.defaultSetup(),this.dispatch=[l,o.outH]}};var ka=\`#version 300 es
// Bilinear upsample + 1\\xD71 pointwise conv fused.
// For each output pixel + out group, bilinearly samples each in_group from input,
// applies the 1\\xD71 conv weight, and writes the activated result.
//
// Input:   (in_W  * in_groups,  in_H)
// Output:  (out_W * out_groups, out_H)
// Weights: (in_groups * 4, out_groups)  (K=1, so kernel-row dimension collapses)
//          mat4[col][row] = weight(in_channel=col, out_channel=row)
// Bias:    (out_groups, 1)

precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform sampler2D u_weights;
uniform sampler2D u_bias;

uniform int u_in_w;
uniform int u_in_h;
uniform int u_out_w;
uniform int u_out_h;
uniform int u_in_c_groups;
uniform int u_out_c_groups;
uniform int u_activation;   // 0 = none, 1 = relu6, 2 = relu

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_out_c_groups;
    int y_out   = fy;
    int o_group = fx - x_out * u_out_c_groups;

    float scale_x = float(u_in_w) / float(u_out_w);
    float scale_y = float(u_in_h) / float(u_out_h);
    float src_x = (float(x_out) + 0.5) * scale_x - 0.5;
    float src_y = (float(y_out) + 0.5) * scale_y - 0.5;

    int x0 = int(floor(src_x));
    int y0 = int(floor(src_y));
    int x1 = x0 + 1;
    int y1 = y0 + 1;
    float fx_w = src_x - float(x0);
    float fy_w = src_y - float(y0);

    x0 = clamp(x0, 0, u_in_w - 1);
    y0 = clamp(y0, 0, u_in_h - 1);
    x1 = clamp(x1, 0, u_in_w - 1);
    y1 = clamp(y1, 0, u_in_h - 1);

    vec4 result = texelFetch(u_bias, ivec2(o_group, 0), 0);

    for (int i = 0; i < u_in_c_groups; i++) {
        vec4 v00 = texelFetch(u_input, ivec2(x0 * u_in_c_groups + i, y0), 0);
        vec4 v10 = texelFetch(u_input, ivec2(x1 * u_in_c_groups + i, y0), 0);
        vec4 v01 = texelFetch(u_input, ivec2(x0 * u_in_c_groups + i, y1), 0);
        vec4 v11 = texelFetch(u_input, ivec2(x1 * u_in_c_groups + i, y1), 0);

        vec4 sampled = mix(mix(v00, v10, fx_w), mix(v01, v11, fx_w), fy_w);

        int base = i * 4;
        mat4 w = mat4(
            texelFetch(u_weights, ivec2(base,     o_group), 0),
            texelFetch(u_weights, ivec2(base + 1, o_group), 0),
            texelFetch(u_weights, ivec2(base + 2, o_group), 0),
            texelFetch(u_weights, ivec2(base + 3, o_group), 0)
        );
        result += w * sampled;
    }

    if      (u_activation == 1) result = clamp(result, 0.0, 6.0);
    else if (u_activation == 2) result = max(result, vec4(0.0));

    fragColor = result;
}
\`;var Nt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",ka);let n=t.c/4,s=o.outChannels/4,p=m(a.weights),c=m(a.bias),l=this.makeTexture(p,n*4,s),f=this.makeTexture(c,s,1),d=o.outW*s,_=this.makeTexture(null,d,o.outH);this.output={h:o.outH,w:o.outW,c:o.outChannels,texture:_,texW:d,texH:o.outH},this.inputs=[t],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_weights",texture:l},{name:"u_bias",texture:f}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_out_w:o.outW,u_out_h:o.outH,u_in_c_groups:n,u_out_c_groups:s,u_activation:o.activation==="relu6"?1:0},this.defaultSetup(),this.dispatch=[d,o.outH]}};var Ta=\`#version 300 es
// Conv2d + skip add fused \\u2014 identical to conv2d.glsl with a skip texture added at write time.
// See conv2d.glsl for tensor/weight layout details.

precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform sampler2D u_skip;
uniform sampler2D u_weights;
uniform sampler2D u_bias;

uniform int u_in_w;
uniform int u_in_h;
uniform int u_in_c_groups;
uniform int u_out_c_groups;
uniform int u_kernel_h;
uniform int u_kernel_w;
uniform int u_stride;
uniform int u_pad_top;
uniform int u_pad_left;
uniform int u_activation;   // 0 = none, 1 = relu6, 2 = relu

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_out_c_groups;
    int y_out   = fy;
    int o_group = fx - x_out * u_out_c_groups;

    vec4 result = texelFetch(u_bias, ivec2(o_group, 0), 0);

    for (int ky = 0; ky < u_kernel_h; ky++) {
        for (int kx = 0; kx < u_kernel_w; kx++) {
            int in_y = y_out * u_stride + ky - u_pad_top;
            int in_x = x_out * u_stride + kx - u_pad_left;

            if (in_y < 0 || in_y >= u_in_h || in_x < 0 || in_x >= u_in_w) continue;

            int z     = ky * u_kernel_w + kx;
            int w_row = z * u_out_c_groups + o_group;

            for (int i = 0; i < u_in_c_groups; i++) {
                vec4 in_val = texelFetch(u_input, ivec2(in_x * u_in_c_groups + i, in_y), 0);

                int base = i * 4;
                mat4 w = mat4(
                    texelFetch(u_weights, ivec2(base,     w_row), 0),
                    texelFetch(u_weights, ivec2(base + 1, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 2, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 3, w_row), 0)
                );
                result += w * in_val;
            }
        }
    }

    if      (u_activation == 1) result = clamp(result, 0.0, 6.0);
    else if (u_activation == 2) result = max(result, vec4(0.0));

    fragColor = result + texelFetch(u_skip, ivec2(fx, fy), 0);
}
\`;var Vt=class extends g{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Ta);let s=C(t.h,n.kernel,n.stride,n.padding),p=C(t.w,n.kernel,n.stride,n.padding),c=t.c/4,l=n.outChannels/4,f=G(n.padding,t.h,s,n.kernel,n.stride),d=G(n.padding,t.w,p,n.kernel,n.stride),_=m(o.weights),b=m(o.bias),x=this.makeTexture(_,c*4,n.kernel*n.kernel*l),v=this.makeTexture(b,l,1),y=p*l,W=this.makeTexture(null,y,s);this.output={h:s,w:p,c:n.outChannels,texture:W,texW:y,texH:s},this.inputs=[t,a],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_skip",texture:a.texture},{name:"u_weights",texture:x},{name:"u_bias",texture:v}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_in_c_groups:c,u_out_c_groups:l,u_kernel_h:n.kernel,u_kernel_w:n.kernel,u_stride:n.stride,u_pad_top:f,u_pad_left:d,u_activation:n.activation==="relu6"?1:0},this.defaultSetup(),this.dispatch=[y,s]}};var Pa=\`#version 300 es
// proj_residual: bespoke 1\\xD71 conv (no activation) + residual add, fused.
// Specializes conv2d_add to kernel=1 / stride=1 / pad=0 / no activation. Both
// inputs share the same spatial resolution. See conv2d.glsl for the weight
// texture layout (here K=1, so the weight texture is (inGroups*4, outGroups)).

precision highp float;
precision highp int;

uniform sampler2D u_input;
uniform sampler2D u_skip;
uniform sampler2D u_weights;
uniform sampler2D u_bias;

uniform int u_in_c_groups;
uniform int u_out_c_groups;

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_out_c_groups;
    int o_group = fx - x_out * u_out_c_groups;

    vec4 result = texelFetch(u_bias, ivec2(o_group, 0), 0);

    for (int i = 0; i < u_in_c_groups; i++) {
        vec4 in_val = texelFetch(u_input, ivec2(x_out * u_in_c_groups + i, fy), 0);

        int base = i * 4;
        mat4 w = mat4(
            texelFetch(u_weights, ivec2(base,     o_group), 0),
            texelFetch(u_weights, ivec2(base + 1, o_group), 0),
            texelFetch(u_weights, ivec2(base + 2, o_group), 0),
            texelFetch(u_weights, ivec2(base + 3, o_group), 0)
        );
        result += w * in_val;
    }

    fragColor = result + texelFetch(u_skip, ivec2(fx, fy), 0);
}
\`;var Xt=class extends g{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Pa);let s=t.c/4,p=n.outChannels/4,c=m(o.weights),l=m(o.bias),f=this.makeTexture(c,s*4,p),d=this.makeTexture(l,p,1),_=t.w*p,b=this.makeTexture(null,_,t.h);this.output={h:t.h,w:t.w,c:n.outChannels,texture:b,texW:_,texH:t.h},this.inputs=[t,a],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_skip",texture:a.texture},{name:"u_weights",texture:f},{name:"u_bias",texture:d}],this.uniformInts={u_in_c_groups:s,u_out_c_groups:p},this.defaultSetup(),this.dispatch=[_,t.h]}};var Ca=\`#version 300 es
// concat_conv2d: fuses [concat(a, b) \\u2192 conv 3\\xD73 (pad 1) \\u2192 relu6] into one pass.
// Both inputs already at output resolution. Weight cols [0, a_groups) read a,
// [a_groups, I) read b. Weight texture layout matches conv2d.glsl
// ((in_groups*4, 9*out_groups), in_groups = a_groups + b_groups).

precision highp float;
precision highp int;

uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_weights;
uniform sampler2D u_bias;

uniform int u_w;
uniform int u_h;
uniform int u_a_groups;
uniform int u_b_groups;
uniform int u_out_c_groups;

out vec4 fragColor;

void main() {
    int fx      = int(gl_FragCoord.x);
    int fy      = int(gl_FragCoord.y);
    int x_out   = fx / u_out_c_groups;
    int o_group = fx - x_out * u_out_c_groups;
    int A = u_a_groups;
    int B = u_b_groups;
    int I = A + B;

    vec4 result = texelFetch(u_bias, ivec2(o_group, 0), 0);

    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int in_y = fy    + ky - 1;
            int in_x = x_out + kx - 1;
            if (in_x < 0 || in_y < 0 || in_x >= u_w || in_y >= u_h) continue;

            int z     = ky * 3 + kx;
            int w_row = z * u_out_c_groups + o_group;

            for (int i = 0; i < I; i++) {
                vec4 in_val = (i < A)
                    ? texelFetch(u_a, ivec2(in_x * A + i,       in_y), 0)
                    : texelFetch(u_b, ivec2(in_x * B + (i - A), in_y), 0);

                int base = i * 4;
                mat4 w = mat4(
                    texelFetch(u_weights, ivec2(base,     w_row), 0),
                    texelFetch(u_weights, ivec2(base + 1, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 2, w_row), 0),
                    texelFetch(u_weights, ivec2(base + 3, w_row), 0)
                );
                result += w * in_val;
            }
        }
    }

    fragColor = clamp(result, 0.0, 6.0);
}
\`;var jt=class extends g{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Ca);let s=t.c/4,p=a.c/4,c=s+p,l=n.outChannels/4,f=m(o.weights),d=m(o.bias),_=this.makeTexture(f,c*4,9*l),b=this.makeTexture(d,l,1),x=t.w*l,v=this.makeTexture(null,x,t.h);this.output={h:t.h,w:t.w,c:n.outChannels,texture:v,texW:x,texH:t.h},this.inputs=[t,a],this.weights=[],this.samplers=[{name:"u_a",texture:t.texture},{name:"u_b",texture:a.texture},{name:"u_weights",texture:_},{name:"u_bias",texture:b}],this.uniformInts={u_w:t.w,u_h:t.h,u_a_groups:s,u_b_groups:p,u_out_c_groups:l},this.defaultSetup(),this.dispatch=[x,t.h]}};var Wa=\`#version 300 es
// gates_fused: ConvGRU z + r gates, fused. Production config (c_up=2,
// recurrent=1). u_in (.x=a, .y=b), h_prev (.x). weights 9 vec4 =
// (z_w_b, z_w_h, r_w_b, r_w_h) in a (9,1) texture. bias .xy. output (z, r, 0, 0).

precision highp float;
precision highp int;

uniform sampler2D u_u_in;     // (W, H)
uniform sampler2D u_h_prev;   // (W, H)
uniform sampler2D u_weights;  // (9, 1)
uniform sampler2D u_bias;     // (1, 1)
uniform int u_w;
uniform int u_h;

out vec4 fragColor;

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    vec2 b = texelFetch(u_bias, ivec2(0, 0), 0).xy;
    float z_pre = b.x;
    float r_pre = b.y;

    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y + ky - 1;
            int ix = x + kx - 1;
            if (iy < 0 || ix < 0 || iy >= u_h || ix >= u_w) continue;
            int kpos  = ky * 3 + kx;
            float b_n = texelFetch(u_u_in,   ivec2(ix, iy), 0).y;
            float h_n = texelFetch(u_h_prev, ivec2(ix, iy), 0).z;
            vec4 w    = texelFetch(u_weights, ivec2(kpos, 0), 0);
            z_pre += w.x * b_n + w.y * h_n;
            r_pre += w.z * b_n + w.w * h_n;
        }
    }

    float z = 1.0 / (1.0 + exp(-z_pre));
    float r = 1.0 / (1.0 + exp(-r_pre));
    fragColor = vec4(z, r, 0.0, 0.0);
}
\`;var qt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Wa);let n=this.makeTexture(m(o.weights),9,1),s=this.makeTexture(w(o.bias),1,1),p=t.w,c=this.makeTexture(null,p,t.h);this.output={h:t.h,w:t.w,c:4,texture:c,texW:p,texH:t.h},this.inputs=[t,a],this.weights=[],this.samplers=[{name:"u_u_in",texture:t.texture},{name:"u_h_prev",texture:a.texture},{name:"u_weights",texture:n},{name:"u_bias",texture:s}],this.uniformInts={u_w:t.w,u_h:t.h},this.defaultSetup(),this.dispatch=[p,t.h]}};var Ga=\`#version 300 es
// cand_update_fused: ConvGRU candidate + state update + output, fused.
// Production config (c_up=2, recurrent=1). u_in (.x=a, .y=b), h_prev (.x),
// gates_out (.x=z, .y=r). weights 9 vec4 (.xy = b_w, rh_w) in a (9,1) texture.
// bias .x, gamma .x. output (a, b_out, 0, 0).

precision highp float;
precision highp int;

uniform sampler2D u_u_in;       // (W, H)
uniform sampler2D u_h_prev;     // (W, H)
uniform sampler2D u_gates_out;  // (W, H)
uniform sampler2D u_weights;    // (9, 1)
uniform sampler2D u_bias;       // (1, 1)
uniform sampler2D u_gamma;      // (1, 1)
uniform int u_w;
uniform int u_h;

out vec4 fragColor;

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    float cand_pre = texelFetch(u_bias, ivec2(0, 0), 0).x;
    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y + ky - 1;
            int ix = x + kx - 1;
            if (iy < 0 || ix < 0 || iy >= u_h || ix >= u_w) continue;
            int kpos  = ky * 3 + kx;
            float b_n = texelFetch(u_u_in,      ivec2(ix, iy), 0).y;
            float h_n = texelFetch(u_h_prev,    ivec2(ix, iy), 0).z;
            float r_n = texelFetch(u_gates_out, ivec2(ix, iy), 0).y;
            vec4 w    = texelFetch(u_weights,   ivec2(kpos, 0), 0);
            cand_pre += w.x * b_n + w.y * (r_n * h_n);
        }
    }

    float h_til      = tanh(cand_pre);
    vec4  u_cur      = texelFetch(u_u_in,      ivec2(x, y), 0);
    float z_cur      = texelFetch(u_gates_out, ivec2(x, y), 0).x;
    float h_prev_cur = texelFetch(u_h_prev,    ivec2(x, y), 0).z;
    float h_new      = (1.0 - z_cur) * h_prev_cur + z_cur * h_til;
    float gamma      = texelFetch(u_gamma,     ivec2(0, 0), 0).x;
    float b_out      = u_cur.y + gamma * h_new;
    fragColor = vec4(u_cur.x, b_out, h_new, 0.0);
}
\`;var $t=class extends g{constructor(r,t,a,o,n,s){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Ga);let p=this.makeTexture(m(n.weights),9,1),c=this.makeTexture(w(n.bias),1,1),l=this.makeTexture(w(s),1,1),f=t.w,d=this.makeTexture(null,f,t.h);this.output={h:t.h,w:t.w,c:4,texture:d,texW:f,texH:t.h},this.inputs=[t,a,o],this.weights=[],this.samplers=[{name:"u_u_in",texture:t.texture},{name:"u_h_prev",texture:a.texture},{name:"u_gates_out",texture:o.texture},{name:"u_weights",texture:p},{name:"u_bias",texture:c},{name:"u_gamma",texture:l}],this.uniformInts={u_w:t.w,u_h:t.h},this.defaultSetup(),this.dispatch=[f,t.h]}};var Ua=\`#version 300 es
// conv_expand: bespoke N\\u21922 conv 3\\xD73 (pad 1) + relu (wrapper expand_feat).
// Input N ch (in_groups vec4); output 2ch in .xy (.zw = 0). Weights: 9 *
// in_groups mat4x2 (8 floats each, col-major c0r0,c0r1,...,c3r0,c3r1) in a
// 1-row texture \\u2014 bounded small (feat_ch \\u2264 32).

precision highp float;
precision highp int;

uniform sampler2D u_input;    // (W*in_groups, H)
uniform sampler2D u_weights;  // (ceil(9*in_groups*8/4), 1)
uniform sampler2D u_bias;     // (1, 1) \\u2014 .xy
uniform int u_w;
uniform int u_h;
uniform int u_in_groups;

out vec4 fragColor;

float wf(int i) { return texelFetch(u_weights, ivec2(i / 4, 0), 0)[i & 3]; }

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    vec2 result = texelFetch(u_bias, ivec2(0, 0), 0).xy;

    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y + ky - 1;
            int ix = x + kx - 1;
            if (iy < 0 || ix < 0 || iy >= u_h || ix >= u_w) continue;
            int kpos = ky * 3 + kx;
            for (int ig = 0; ig < u_in_groups; ig++) {
                vec4 v = texelFetch(u_input, ivec2(ix * u_in_groups + ig, iy), 0);
                int base = (kpos * u_in_groups + ig) * 8;  // mat4x2 = 8 floats
                result.x += wf(base + 0) * v.x + wf(base + 2) * v.y + wf(base + 4) * v.z + wf(base + 6) * v.w;
                result.y += wf(base + 1) * v.x + wf(base + 3) * v.y + wf(base + 5) * v.z + wf(base + 7) * v.w;
            }
        }
    }

    fragColor = vec4(max(result, vec2(0.0)), 0.0, 0.0);   // expand_feat is F.relu
}
\`;var Kt=class extends g{constructor(r,t,a){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Ua);let o=t.c/4,n=this.makeTexture(m(a.weights),18*o,1),s=this.makeTexture(w(a.bias),1,1),p=t.w,c=this.makeTexture(null,p,t.h);this.output={h:t.h,w:t.w,c:4,texture:c,texW:p,texH:t.h},this.inputs=[t],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_weights",texture:n},{name:"u_bias",texture:s}],this.uniformInts={u_w:t.w,u_h:t.h,u_in_groups:o},this.defaultSetup(),this.dispatch=[p,t.h]}};var Ba=\`#version 300 es
// cat_conv_6to2: fused concat(u[2], d[4]) \\u2192 6\\u21922 conv 3\\xD73 (pad 1) + relu
// (E up1_combine). Channel order v3a=(u.x,u.y,d.x), v3b=d.yzw. weights = 9*2
// mat3x2 (6 floats each, col-major) in a 1-row (27-texel) texture.

precision highp float;
precision highp int;

uniform sampler2D u_u_in;     // (W, H) \\u2014 .xy
uniform sampler2D u_d_in;     // (W, H) \\u2014 full vec4
uniform sampler2D u_weights;  // (27, 1)
uniform sampler2D u_bias;     // (1, 1) \\u2014 .xy
uniform int u_w;
uniform int u_h;

out vec4 fragColor;

float wf(int i) { return texelFetch(u_weights, ivec2(i / 4, 0), 0)[i & 3]; }

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    vec2 result = texelFetch(u_bias, ivec2(0, 0), 0).xy;
    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y + ky - 1;
            int ix = x + kx - 1;
            if (iy < 0 || ix < 0 || iy >= u_h || ix >= u_w) continue;
            int kpos = ky * 3 + kx;
            vec4 u = texelFetch(u_u_in, ivec2(ix, iy), 0);
            vec4 d = texelFetch(u_d_in, ivec2(ix, iy), 0);
            vec3 v3a = vec3(u.x, u.y, d.x);
            vec3 v3b = d.yzw;
            for (int ig = 0; ig < 2; ig++) {
                int base = (kpos * 2 + ig) * 6;
                vec3 v3 = (ig == 0) ? v3a : v3b;
                for (int col = 0; col < 3; col++) {
                    result.x += wf(base + col * 2 + 0) * v3[col];
                    result.y += wf(base + col * 2 + 1) * v3[col];
                }
            }
        }
    }

    fragColor = vec4(max(result, vec2(0.0)), 0.0, 0.0);   // up1_combine is F.relu
}
\`;var Yt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Ba);let n=this.makeTexture(m(o.weights),27,1),s=this.makeTexture(w(o.bias),1,1),p=t.w,c=this.makeTexture(null,p,t.h);this.output={h:t.h,w:t.w,c:4,texture:c,texW:p,texH:t.h},this.inputs=[t,a],this.weights=[],this.samplers=[{name:"u_u_in",texture:t.texture},{name:"u_d_in",texture:a.texture},{name:"u_weights",texture:n},{name:"u_bias",texture:s}],this.uniformInts={u_w:t.w,u_h:t.h},this.defaultSetup(),this.dispatch=[p,t.h]}};var Sa=\`#version 300 es
// down_adapter: stride-N 3\\xD73 conv (mat4x4, 4\\u21924) + relu, then 1\\xD71 adapter
// (4\\u21923, last row 0). down_w = 9 mat4x4 (1-row, 36 texels); adapt_w = 1 mat4x4
// (4 texels). Output 3ch in .xyz (.w=0). Symmetric pad. Weight packing matches
// conv2d (col-major mat4x4 via the flat accessor).

precision highp float;
precision highp int;

uniform sampler2D u_input;     // (in_W, in_H) \\u2014 in_c padded to 1 vec4
uniform sampler2D u_down_w;    // (36, 1)
uniform sampler2D u_down_b;    // (1, 1)
uniform sampler2D u_adapt_w;   // (4, 1)
uniform sampler2D u_adapt_b;   // (1, 1) \\u2014 .xyz
uniform int u_in_w;
uniform int u_in_h;
uniform int u_stride;
uniform int u_pad;

out vec4 fragColor;

float dwf(int i) { return texelFetch(u_down_w,  ivec2(i / 4, 0), 0)[i & 3]; }
float awf(int i) { return texelFetch(u_adapt_w, ivec2(i / 4, 0), 0)[i & 3]; }

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    vec4 d = texelFetch(u_down_b, ivec2(0, 0), 0);
    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y * u_stride + ky - u_pad;
            int ix = x * u_stride + kx - u_pad;
            if (iy < 0 || ix < 0 || iy >= u_in_h || ix >= u_in_w) continue;
            int kpos = ky * 3 + kx;
            vec4 v = texelFetch(u_input, ivec2(ix, iy), 0);
            int m = kpos * 16;
            d.x += dwf(m + 0) * v.x + dwf(m + 4) * v.y + dwf(m + 8)  * v.z + dwf(m + 12) * v.w;
            d.y += dwf(m + 1) * v.x + dwf(m + 5) * v.y + dwf(m + 9)  * v.z + dwf(m + 13) * v.w;
            d.z += dwf(m + 2) * v.x + dwf(m + 6) * v.y + dwf(m + 10) * v.z + dwf(m + 14) * v.w;
            d.w += dwf(m + 3) * v.x + dwf(m + 7) * v.y + dwf(m + 11) * v.z + dwf(m + 15) * v.w;
        }
    }
    d = max(d, vec4(0.0));   // relu

    vec4 ab = texelFetch(u_adapt_b, ivec2(0, 0), 0);
    vec4 a;
    a.x = awf(0) * d.x + awf(4) * d.y + awf(8)  * d.z + awf(12) * d.w + ab.x;
    a.y = awf(1) * d.x + awf(5) * d.y + awf(9)  * d.z + awf(13) * d.w + ab.y;
    a.z = awf(2) * d.x + awf(6) * d.y + awf(10) * d.z + awf(14) * d.w + ab.z;
    fragColor = vec4(a.xyz, 0.0);
}
\`;var Qt=class extends g{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Sa);let s=C(t.h,3,n.stride,1),p=C(t.w,3,n.stride,1),c=G(1,t.h,s,3,n.stride),l=this.makeTexture(m(a.weights),36,1),f=this.makeTexture(w(a.bias),1,1),d=this.makeTexture(m(o.weights),4,1),_=this.makeTexture(w(o.bias),1,1),b=p,x=this.makeTexture(null,b,s);this.output={h:s,w:p,c:4,texture:x,texW:b,texH:s},this.inputs=[t],this.weights=[],this.samplers=[{name:"u_input",texture:t.texture},{name:"u_down_w",texture:l},{name:"u_down_b",texture:f},{name:"u_adapt_w",texture:d},{name:"u_adapt_b",texture:_}],this.uniformInts={u_in_w:t.w,u_in_h:t.h,u_stride:n.stride,u_pad:c},this.defaultSetup(),this.dispatch=[b,s]}};var Aa=\`#version 300 es
// up_final: cat(u[2], rgb[3]) \\u2192 conv 3\\xD73 5\\u21921 \\u2192 sigmoid (A/B alpha head).
// weights 18 vec4 (1-row): [kpos]=(w0,w1,0,0) for u, [9+kpos]=(w2,w3,w4,0) rgb.

precision highp float;
precision highp int;

uniform sampler2D u_u_gru;    // (W, H) \\u2014 .xy
uniform sampler2D u_rgb;      // (W, H) \\u2014 .xyz
uniform sampler2D u_weights;  // (18, 1)
uniform sampler2D u_bias;     // (1, 1) \\u2014 .x
uniform int u_w;
uniform int u_h;

out vec4 fragColor;

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    float acc = texelFetch(u_bias, ivec2(0, 0), 0).x;
    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y + ky - 1;
            int ix = x + kx - 1;
            if (iy < 0 || ix < 0 || iy >= u_h || ix >= u_w) continue;
            int kpos = ky * 3 + kx;
            vec4 u  = texelFetch(u_u_gru,   ivec2(ix, iy), 0);
            vec4 r  = texelFetch(u_rgb,     ivec2(ix, iy), 0);
            vec4 wu = texelFetch(u_weights, ivec2(kpos, 0), 0);
            vec4 wr = texelFetch(u_weights, ivec2(9 + kpos, 0), 0);
            acc += dot(wu.xy, u.xy);
            acc += dot(wr.xyz, r.xyz);
        }
    }

    fragColor = vec4(1.0 / (1.0 + exp(-acc)), 0.0, 0.0, 0.0);
}
\`;var Jt=class extends g{constructor(r,t,a,o){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",Aa);let n=this.makeTexture(m(o.weights),18,1),s=this.makeTexture(w(o.bias),1,1),p=t.w,c=this.makeTexture(null,p,t.h);this.output={h:t.h,w:t.w,c:4,texture:c,texW:p,texH:t.h},this.inputs=[t,a],this.weights=[],this.samplers=[{name:"u_u_gru",texture:t.texture},{name:"u_rgb",texture:a.texture},{name:"u_weights",texture:n},{name:"u_bias",texture:s}],this.uniformInts={u_w:t.w,u_h:t.h},this.defaultSetup(),this.dispatch=[p,t.h]}};var La=\`#version 300 es
// up_final_skip (C/D alpha head): cat(u[2], d_full[4], rgb[3]) \\u2192 conv 9\\u21921 \\u2192
// sigmoid. Weights = 27 vec4 (3 per kpos): [kpos*3+0]=(w0,w1,0,0) u;
// [kpos*3+1]=(w2..w5) d_full; [kpos*3+2]=(w6,w7,w8,0) rgb.

precision highp float;
precision highp int;

uniform sampler2D u_u_gru;    // (W, H) \\u2014 .xy
uniform sampler2D u_d_full;   // (W, H) \\u2014 full vec4
uniform sampler2D u_rgb;      // (W, H) \\u2014 .xyz
uniform sampler2D u_weights;  // (27, 1)
uniform sampler2D u_bias;     // (1, 1) \\u2014 .x
uniform int u_w;
uniform int u_h;

out vec4 fragColor;

float wf(int i) { return texelFetch(u_weights, ivec2(i / 4, 0), 0)[i & 3]; }

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);

    float acc = texelFetch(u_bias, ivec2(0, 0), 0).x;
    for (int ky = 0; ky < 3; ky++) {
        for (int kx = 0; kx < 3; kx++) {
            int iy = y + ky - 1;
            int ix = x + kx - 1;
            if (iy < 0 || ix < 0 || iy >= u_h || ix >= u_w) continue;
            int kpos = ky * 3 + kx;
            vec4 u = texelFetch(u_u_gru,  ivec2(ix, iy), 0);
            vec4 d = texelFetch(u_d_full, ivec2(ix, iy), 0);
            vec4 r = texelFetch(u_rgb,    ivec2(ix, iy), 0);
            int b0 = (kpos * 3 + 0) * 4, b1 = (kpos * 3 + 1) * 4, b2 = (kpos * 3 + 2) * 4;
            acc += wf(b0 + 0) * u.x + wf(b0 + 1) * u.y;
            acc += wf(b1 + 0) * d.x + wf(b1 + 1) * d.y + wf(b1 + 2) * d.z + wf(b1 + 3) * d.w;
            acc += wf(b2 + 0) * r.x + wf(b2 + 1) * r.y + wf(b2 + 2) * r.z;
        }
    }

    fragColor = vec4(1.0 / (1.0 + exp(-acc)), 0.0, 0.0, 0.0);
}
\`;var Zt=class extends g{constructor(r,t,a,o,n){super(r);i(this,"inputs");i(this,"weights");i(this,"output");i(this,"dispatch");i(this,"shader",La);let s=this.makeTexture(m(n.weights),27,1),p=this.makeTexture(w(n.bias),1,1),c=t.w,l=this.makeTexture(null,c,t.h);this.output={h:t.h,w:t.w,c:4,texture:l,texW:c,texH:t.h},this.inputs=[t,a,o],this.weights=[],this.samplers=[{name:"u_u_gru",texture:t.texture},{name:"u_d_full",texture:a.texture},{name:"u_rgb",texture:o.texture},{name:"u_weights",texture:s},{name:"u_bias",texture:p}],this.uniformInts={u_w:t.w,u_h:t.h},this.defaultSetup(),this.dispatch=[c,t.h]}};var Fa=\`#version 300 es
// Composite an RGBA image over a solid background color, gated by a
// 1-channel alpha mask. Output: premultiplied RGBA.
//
// Assumes image and alpha textures are the same h\\xD7w and that the canvas
// (viewport) matches that resolution \\u2014 no resampling here. The upscaler op
// (separate) handles aligning alpha to the image resolution upstream.

precision highp float;

uniform sampler2D u_image;   // image as NHWC vec4 (RGBA in vec4)
uniform sampler2D u_alpha;   // alpha as NHWC vec4 (value in .r)
uniform vec3      u_bgColor; // straight-alpha background color, [0,1]

out vec4 fragColor;

void main() {
    // WebGL gl_FragCoord origin is bottom-left, but tensor textures are
    // stored top-down (matches NHWC + getImageData). Flip y when sampling so
    // the displayed image is upright. (WebGPU's @builtin(position) is already
    // top-down, so its compositor doesn't need this.)
    int H = textureSize(u_image, 0).y;
    ivec2 px = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));
    vec3  fg = texelFetch(u_image, px, 0).rgb;
    float a  = texelFetch(u_alpha, px, 0).r;

    // Straight-alpha composite, then premultiply for the canvas's
    // premultiplied surface format.
    vec3 rgb = fg * a + u_bgColor * (1.0 - a);
    fragColor = vec4(rgb, 1.0);
}
\`;var Hn=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,er=class{constructor(e,r,t,a){i(this,"backend",e);i(this,"program");i(this,"imageTex");i(this,"alphaTex");i(this,"bgColor");if(r.h!==t.h||r.w!==t.w)throw new Error(\`CompositeSolid: image (\${r.h}\\xD7\${r.w}) and alpha (\${t.h}\\xD7\${t.w}) must match. Run the upscaler first.\`);let o=r,n=t;this.imageTex=o.texture,this.alphaTex=n.texture,this.bgColor=a;let s=e.gl,p=s.createShader(s.VERTEX_SHADER);s.shaderSource(p,Hn),s.compileShader(p);let c=s.createShader(s.FRAGMENT_SHADER);if(s.shaderSource(c,Fa),s.compileShader(c),!s.getShaderParameter(c,s.COMPILE_STATUS))throw new Error(\`composite_solid GLSL compile error: \${s.getShaderInfoLog(c)}\`);if(this.program=s.createProgram(),s.attachShader(this.program,p),s.attachShader(this.program,c),s.linkProgram(this.program),!s.getProgramParameter(this.program,s.LINK_STATUS))throw new Error(\`composite_solid GLSL link error: \${s.getProgramInfoLog(this.program)}\`)}run(){let e=this.backend.gl;e.useProgram(this.program),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.imageTex),e.uniform1i(e.getUniformLocation(this.program,"u_image"),0),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,this.alphaTex),e.uniform1i(e.getUniformLocation(this.program,"u_alpha"),1),e.uniform3f(e.getUniformLocation(this.program,"u_bgColor"),this.bgColor[0],this.bgColor[1],this.bgColor[2]),this.backend.bindDisplayFramebuffer(),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6)}};var Ea=\`#version 300 es
// Same as composite_solid but bg is a texture (NHWC vec4 tensor) instead of
// a uniform color. Caller invariants: image, alpha, bg all share h \\xD7 w, and
// canvas dimensions match.

precision highp float;
precision highp int;

uniform sampler2D u_image;
uniform sampler2D u_alpha;
uniform sampler2D u_bg;

out vec4 fragColor;

void main() {
    // WebGL gl_FragCoord origin is bottom-left; tensor textures are top-down.
    int H = textureSize(u_image, 0).y;
    ivec2 px = ivec2(int(gl_FragCoord.x), H - 1 - int(gl_FragCoord.y));

    vec3  fg = texelFetch(u_image, px, 0).rgb;
    float a  = texelFetch(u_alpha, px, 0).r;
    vec3  bg = texelFetch(u_bg,    px, 0).rgb;

    vec3 rgb = fg * a + bg * (1.0 - a);
    fragColor = vec4(rgb, 1.0);
}
\`;var Vn=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,tr=class{constructor(e,r,t,a){i(this,"backend",e);i(this,"program");i(this,"imageTex");i(this,"alphaTex");i(this,"bgTex");if(r.h!==t.h||r.w!==t.w||r.h!==a.h||r.w!==a.w)throw new Error(\`CompositeImage: image (\${r.h}\\xD7\${r.w}), alpha (\${t.h}\\xD7\${t.w}), and bg (\${a.h}\\xD7\${a.w}) must all match. Run upscaler / resizer first.\`);this.imageTex=r.texture,this.alphaTex=t.texture,this.bgTex=a.texture;let o=e.gl,n=o.createShader(o.VERTEX_SHADER);o.shaderSource(n,Vn),o.compileShader(n);let s=o.createShader(o.FRAGMENT_SHADER);if(o.shaderSource(s,Ea),o.compileShader(s),!o.getShaderParameter(s,o.COMPILE_STATUS))throw new Error(\`composite_image GLSL compile error: \${o.getShaderInfoLog(s)}\`);if(this.program=o.createProgram(),o.attachShader(this.program,n),o.attachShader(this.program,s),o.linkProgram(this.program),!o.getProgramParameter(this.program,o.LINK_STATUS))throw new Error(\`composite_image GLSL link error: \${o.getProgramInfoLog(this.program)}\`)}run(){let e=this.backend.gl;e.useProgram(this.program),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.imageTex),e.uniform1i(e.getUniformLocation(this.program,"u_image"),0),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,this.alphaTex),e.uniform1i(e.getUniformLocation(this.program,"u_alpha"),1),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.bgTex),e.uniform1i(e.getUniformLocation(this.program,"u_bg"),2),this.backend.bindDisplayFramebuffer(),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6)}};var Ra=\`#version 300 es
// Like composite_image but bg is bilinearly sampled \\u2014 bg is at a smaller
// resolution than (image, alpha) at canvas h \\xD7 w. Used by CompositorBlur to
// skip the final full-res upsample in the blur pyramid.
//
// Tensor textures are top-down (origin at top-left of the source image),
// while gl_FragCoord origin is bottom-left \\u2014 flip y when computing px.

precision highp float;
precision highp int;

uniform sampler2D u_image;
uniform sampler2D u_alpha;
uniform sampler2D u_bg;

uniform int u_out_w;
uniform int u_out_h;
uniform int u_bg_w;
uniform int u_bg_h;

out vec4 fragColor;

void main() {
    int x = int(gl_FragCoord.x);
    int y = u_out_h - 1 - int(gl_FragCoord.y);

    vec3  fg = texelFetch(u_image, ivec2(x, y), 0).rgb;
    float a  = texelFetch(u_alpha, ivec2(x, y), 0).r;

    // Bilinear sample bg at the corresponding location. align_corners=False.
    float src_x = (float(x) + 0.5) * (float(u_bg_w) / float(u_out_w)) - 0.5;
    float src_y = (float(y) + 0.5) * (float(u_bg_h) / float(u_out_h)) - 0.5;
    int x0 = clamp(int(floor(src_x)),     0, u_bg_w - 1);
    int x1 = clamp(int(floor(src_x)) + 1, 0, u_bg_w - 1);
    int y0 = clamp(int(floor(src_y)),     0, u_bg_h - 1);
    int y1 = clamp(int(floor(src_y)) + 1, 0, u_bg_h - 1);
    float wx = src_x - floor(src_x);
    float wy = src_y - floor(src_y);

    vec3 tl = texelFetch(u_bg, ivec2(x0, y0), 0).rgb;
    vec3 tr = texelFetch(u_bg, ivec2(x1, y0), 0).rgb;
    vec3 bl = texelFetch(u_bg, ivec2(x0, y1), 0).rgb;
    vec3 br = texelFetch(u_bg, ivec2(x1, y1), 0).rgb;
    vec3 bg = (1.0 - wy) * ((1.0 - wx) * tl + wx * tr)
            +        wy  * ((1.0 - wx) * bl + wx * br);

    vec3 rgb = fg * a + bg * (1.0 - a);
    fragColor = vec4(rgb, 1.0);
}
\`;var jn=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,rr=class{constructor(e,r,t,a){i(this,"backend",e);i(this,"program");i(this,"imageTex");i(this,"alphaTex");i(this,"bgTex");i(this,"outW");i(this,"outH");i(this,"bgW");i(this,"bgH");if(r.h!==t.h||r.w!==t.w)throw new Error(\`CompositeImageBilinear: image (\${r.h}\\xD7\${r.w}) and alpha (\${t.h}\\xD7\${t.w}) must match.\`);this.imageTex=r.texture,this.alphaTex=t.texture,this.bgTex=a.texture,this.outW=r.w,this.outH=r.h,this.bgW=a.w,this.bgH=a.h;let o=e.gl,n=o.createShader(o.VERTEX_SHADER);o.shaderSource(n,jn),o.compileShader(n);let s=o.createShader(o.FRAGMENT_SHADER);if(o.shaderSource(s,Ra),o.compileShader(s),!o.getShaderParameter(s,o.COMPILE_STATUS))throw new Error(\`composite_image_bilinear GLSL compile error: \${o.getShaderInfoLog(s)}\`);if(this.program=o.createProgram(),o.attachShader(this.program,n),o.attachShader(this.program,s),o.linkProgram(this.program),!o.getProgramParameter(this.program,o.LINK_STATUS))throw new Error(\`composite_image_bilinear GLSL link error: \${o.getProgramInfoLog(this.program)}\`)}run(){let e=this.backend.gl;e.useProgram(this.program),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.imageTex),e.uniform1i(e.getUniformLocation(this.program,"u_image"),0),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,this.alphaTex),e.uniform1i(e.getUniformLocation(this.program,"u_alpha"),1),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.bgTex),e.uniform1i(e.getUniformLocation(this.program,"u_bg"),2),e.uniform1i(e.getUniformLocation(this.program,"u_out_w"),this.outW),e.uniform1i(e.getUniformLocation(this.program,"u_out_h"),this.outH),e.uniform1i(e.getUniformLocation(this.program,"u_bg_w"),this.bgW),e.uniform1i(e.getUniformLocation(this.program,"u_bg_h"),this.bgH),this.backend.bindDisplayFramebuffer(),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6)}};var qn=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,or=class{constructor(e,r){i(this,"backend",e);i(this,"program");i(this,"imageTex");this.imageTex=r.texture;let t=e.gl,a=t.createShader(t.VERTEX_SHADER);t.shaderSource(a,qn),t.compileShader(a);let o=t.createShader(t.FRAGMENT_SHADER);if(t.shaderSource(o,At),t.compileShader(o),!t.getShaderParameter(o,t.COMPILE_STATUS))throw new Error(\`composite_passthrough GLSL compile error: \${t.getShaderInfoLog(o)}\`);if(this.program=t.createProgram(),t.attachShader(this.program,a),t.attachShader(this.program,o),t.linkProgram(this.program),!t.getProgramParameter(this.program,t.LINK_STATUS))throw new Error(\`composite_passthrough GLSL link error: \${t.getProgramInfoLog(this.program)}\`)}run(){let e=this.backend.gl;e.useProgram(this.program),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.imageTex),e.uniform1i(e.getUniformLocation(this.program,"u_image"),0),this.backend.bindDisplayFramebuffer(),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6)}};var Da=\`#version 300 es
precision highp float;

// Input op \\u2014 bilinear-sample a source texture (RGBA8 unorm uploaded from an
// ImageBitmap or VideoFrame) at the target resolution. Output texture format
// is RGBA32F or RGBA16F depending on backend.dtype; the framebuffer write
// stores fragColor into whatever format is bound.

uniform sampler2D u_src;
uniform int       u_out_w;
uniform int       u_out_h;

out vec4 fragColor;

void main() {
    vec2 uv = (gl_FragCoord.xy + vec2(0.5)) / vec2(float(u_out_w), float(u_out_h));
    fragColor = texture(u_src, uv);
}
\`;var Kn=\`#version 300 es
const vec2 VERTS[6] = vec2[6](
    vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
    vec2(-1.0,1.0),  vec2(1.0,-1.0), vec2(1.0,1.0)
);
void main() { gl_Position = vec4(VERTS[gl_VertexID], 0.0, 1.0); }\`,ar=class{constructor(e,r,t){i(this,"backend",e);i(this,"output");i(this,"gl");i(this,"program");i(this,"srcTex");i(this,"uOutW");i(this,"uOutH");i(this,"uSrc");i(this,"source",null);let a=e.gl;this.gl=a,this.output=e.tensor(r,t,4),this.srcTex=a.createTexture(),a.bindTexture(a.TEXTURE_2D,this.srcTex),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MIN_FILTER,a.LINEAR),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MAG_FILTER,a.LINEAR),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_S,a.CLAMP_TO_EDGE),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_T,a.CLAMP_TO_EDGE);let o=a.createShader(a.VERTEX_SHADER);a.shaderSource(o,Kn),a.compileShader(o);let n=a.createShader(a.FRAGMENT_SHADER);if(a.shaderSource(n,Da),a.compileShader(n),!a.getShaderParameter(n,a.COMPILE_STATUS))throw new Error(\`Input GLSL compile error: \${a.getShaderInfoLog(n)}\`);if(this.program=a.createProgram(),a.attachShader(this.program,o),a.attachShader(this.program,n),a.linkProgram(this.program),!a.getProgramParameter(this.program,a.LINK_STATUS))throw new Error(\`Input GLSL link error: \${a.getProgramInfoLog(this.program)}\`);this.uSrc=a.getUniformLocation(this.program,"u_src"),this.uOutW=a.getUniformLocation(this.program,"u_out_w"),this.uOutH=a.getUniformLocation(this.program,"u_out_h")}setSource(e){this.source=e}run(){if(!this.source)throw new Error("InputWebGL.run() called before setSource()");let e=this.gl;e.bindTexture(e.TEXTURE_2D,this.srcTex),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,this.source),e.useProgram(this.program),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.srcTex),e.uniform1i(this.uSrc,0),e.uniform1i(this.uOutW,this.output.w),e.uniform1i(this.uOutH,this.output.h),e.bindFramebuffer(e.FRAMEBUFFER,this.backend.fbo),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,this.output.texture,0),e.viewport(0,0,this.output.texW,this.output.texH),e.bindVertexArray(null),e.drawArrays(e.TRIANGLES,0,6)}};var ee=class u{constructor(e,r,t){i(this,"gl",e);i(this,"canvas",r);i(this,"dtype",t);i(this,"ops");i(this,"presenters");i(this,"fbo");i(this,"textureFormat");this.fbo=e.createFramebuffer(),this.textureFormat=t==="f16"?{internalFormat:e.RGBA16F,format:e.RGBA,type:e.HALF_FLOAT,bytesPerElement:2}:{internalFormat:e.RGBA32F,format:e.RGBA,type:e.FLOAT,bytesPerElement:4},this.ops={Conv2d:(a,o,n)=>new vt(this,a,o,n),ConvTranspose2d:(a,o,n)=>new xt(this,a,o,n),DepthwiseConv2d:(a,o,n)=>new yt(this,a,o,n),Add:(a,o)=>new wt(this,a,o),Sigmoid:a=>new kt(this,a),Tanh:a=>new Tt(this,a),ElementwiseMul:(a,o)=>new Pt(this,a,o),Warp:(a,o,n)=>new Ct(this,a,o,n),FaceBoxFromHeatmaps:(a,o)=>new Wt(this,a,o),FaceBoxesFromHeatmaps:(a,o)=>new Gt(this,a,o),ReframeState:(a,o,n,s)=>new Ut(this,a,o,n,s),Reframe:(a,o)=>new Bt(this,a,o),CropResample:(a,o,n)=>new St(this,a,o,n),FaceTouchupStage:(a,o,n,s,p)=>new Et(this,a,o,n,s,p),Stabilize:(a,o,n,s,p)=>new Rt(this,a,o,n,s,p),BilinearUpsample:(a,o)=>new Dt(this,a,o),Crop:(a,o)=>new Ot(this,a,o),BicubicUpsample:(a,o)=>new It(this,a,o),ChannelConcat:(a,o)=>new Mt(this,a,o),Conv2dAdd:(a,o,n,s)=>new Vt(this,a,o,n,s),ProjResidual:(a,o,n,s)=>new Xt(this,a,o,n,s),ConcatConv2d:(a,o,n,s)=>new jt(this,a,o,n,s),GatesFused:(a,o,n)=>new qt(this,a,o,n),CandUpdateFused:(a,o,n,s,p)=>new $t(this,a,o,n,s,p),ConvExpand:(a,o)=>new Kt(this,a,o),CatConv6to2:(a,o,n)=>new Yt(this,a,o,n),DownAdapter:(a,o,n,s)=>new Qt(this,a,o,n,s),UpFinal:(a,o,n)=>new Jt(this,a,o,n),UpFinalSkip:(a,o,n,s)=>new Zt(this,a,o,n,s),UpsampleConcat:(a,o,n)=>new Ht(this,a,o,n),UpsampleConv1x1:(a,o,n)=>new Nt(this,a,o,n),UpsampleSigmoid:(a,o)=>new zt(this,a,o),Input:(a,o)=>new ar(this,a,o)},this.presenters={CompositeSolid:(a,o,n)=>new er(this,a,o,n),CompositeImage:(a,o,n)=>new tr(this,a,o,n),CompositeImageBilinear:(a,o,n)=>new rr(this,a,o,n),CompositePassthrough:a=>new or(this,a),LandmarkOverlay:(a,o,n,s)=>new Lt(this,a,o,n,s),FaceTouchup:(a,o,n,s,p)=>new Ft(this,a,o,n,s,p)}}static isAvailable(){let e=null;try{return e=new OffscreenCanvas(1,1).getContext("webgl2"),!(!e||!e.getExtension("EXT_color_buffer_float"))}catch{return!1}finally{e?.getExtension("WEBGL_lose_context")?.loseContext()}}static create(e){let r=e.canvas.getContext("webgl2");if(!r)throw new Error("WebGL2 not available");if(!r.getExtension("EXT_color_buffer_float"))throw new Error("EXT_color_buffer_float not available");return new u(r,e.canvas,e.dtype??"f32")}attachCanvas(e){throw new Error(\`WebGLBackend.attachCanvas('\${e}'): WebGL cannot render to a second canvas; use the renderer's snapshot-and-present path for preview output\`)}bindDisplayFramebuffer(){this.gl.bindFramebuffer(this.gl.FRAMEBUFFER,null),this.gl.viewport(0,0,this.canvas.width,this.canvas.height)}toTextureView(e){if(e===null)return null;let r=this.dtype==="f16",t=e instanceof Uint16Array;return r===t?e:r?Le(e):ae(e)}tensor(e,r,t,a){let o=r*(t/4),n=e,s=this.gl,p=s.createTexture(),c=this.textureFormat,l=this.toTextureView(a??null);return s.bindTexture(s.TEXTURE_2D,p),s.texImage2D(s.TEXTURE_2D,0,c.internalFormat,o,n,0,c.format,c.type,l),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_S,s.CLAMP_TO_EDGE),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_WRAP_T,s.CLAMP_TO_EDGE),{h:e,w:r,c:t,texture:p,texW:o,texH:n}}upload(e){return{data:e}}async readback(e){let r=this.gl,t=this.textureFormat;if(r.bindFramebuffer(r.FRAMEBUFFER,this.fbo),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,e.texture,0),this.dtype==="f16"){let o=new Uint16Array(e.texW*e.texH*4);return r.readPixels(0,0,e.texW,e.texH,t.format,r.HALF_FLOAT,o),r.bindFramebuffer(r.FRAMEBUFFER,null),ae(o)}let a=new Float32Array(e.texW*e.texH*4);return r.readPixels(0,0,e.texW,e.texH,t.format,r.FLOAT,a),r.bindFramebuffer(r.FRAMEBUFFER,null),a}copyTensor(e,r){if(e.texW!==r.texW||e.texH!==r.texH)throw new Error(\`copyTensor: size mismatch (src \${e.texW}\\xD7\${e.texH} vs dst \${r.texW}\\xD7\${r.texH})\`);let t=this.gl;t.bindFramebuffer(t.FRAMEBUFFER,this.fbo),t.framebufferTexture2D(t.FRAMEBUFFER,t.COLOR_ATTACHMENT0,t.TEXTURE_2D,e.texture,0),t.bindTexture(t.TEXTURE_2D,r.texture),t.copyTexSubImage2D(t.TEXTURE_2D,0,0,0,0,0,e.texW,e.texH),t.bindFramebuffer(t.FRAMEBUFFER,null)}async sync(){let e=this.gl,r=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0);if(!r){e.finish();return}for(e.flush();;){let t=e.clientWaitSync(r,0,0);if(t===e.ALREADY_SIGNALED||t===e.CONDITION_SATISFIED){e.deleteSync(r);return}if(t===e.WAIT_FAILED)throw e.deleteSync(r),new Error("WebGLBackend.sync: clientWaitSync returned WAIT_FAILED");await new Promise(a=>setTimeout(a,1))}}destroy(){this.gl.deleteFramebuffer(this.fbo),this.gl.getExtension("WEBGL_lose_context")?.loseContext()}};var hr=Y("setup_backend");async function Oa(u,e,r={}){let t=u.backend==="webgpu"||u.backend==="auto",a=!!u.outputCanvas,o=()=>u.outputCanvas??new OffscreenCanvas(e.w,e.h),n=null;if(t&&await ne.isAvailable()){let p=u.dtype==="f16"&&!await ne.hasF16Support()?"f32":u.dtype,c=o();try{let l=await ne.create({canvas:c,dtype:p});return l.device.lost.then(f=>{f.reason!=="destroyed"&&r.onContextLost?.({message:\`WebGPU device lost: \${f.reason}\${f.message?" \\u2014 "+f.message:""}\`,source:"backend-lost",recoverable:!1,cause:f})}).catch(()=>{}),{backend:l,resolvedBackend:"webgpu",resolvedDtype:p,canvas:c}}catch(l){hr.warn("WebGPU isAvailable but create() threw; trying WebGL fallback:",l),n=l,a&&hr.warn("transfer-capture topology: WebGL fallback may also fail on the same canvas")}}if(ee.isAvailable()){let p=o();try{let c=ee.create({canvas:p,dtype:u.dtype});return p.addEventListener("webglcontextlost",l=>{r.onContextLost?.({message:"WebGL context lost",source:"backend-lost",recoverable:!1,cause:l})}),{backend:c,resolvedBackend:"webgl",resolvedDtype:u.dtype,canvas:p}}catch(c){hr.warn("WebGL create() threw:",c),n=c}}let s=n?\` (last error: \${n.message??n})\`:"";throw new Error(\`setup_backend: no usable GPU backend\${s}\`)}var Ia=.5,Yn=3,Ma=10,Qn=30,te=Y("autotune");async function za(u,e=Qn){let r=u instanceof ee?Ia*.5:Ia,t=1e3/e*r;te(\`start; budget per source frame: \${t.toFixed(1)}ms (source \${e}fps \\xD7 \${r} safety)\`),te("backend dtype:",u.dtype);let a=null;for(let o of nr)if(o.model!=="xl"){if(!J[o.model]){te("skip",o.model,"(no TIER_CONFIG entry)");continue}try{let n=J[o.model].baseRes;te(\`bench \${o.model} base @ \${n.w}\\xD7\${n.h} skipFrames=\${o.skipFrames} \\u2026\`);let s=await eu(u,o),p=s<=t;if(te(\`  \${o.model}: \${s.toFixed(1)}ms / source frame \${p?"\\u2713 within budget":"\\u2717 over budget"}\`),(p||a===null)&&(a=o),!p)break}catch(n){te("  bench failed for",o.model,":",n);break}}if(!a)throw new Error("autotune: no implementable preset available");return te("picked",a.model),a}function Jn(u){let e=Object.create(u);return e.ops={...u.ops,Conv2d:(r,t,a)=>{let o={weights:new Float32Array(a.kernel*a.kernel*r.c*a.outChannels),bias:new Float32Array(a.outChannels)};return u.ops.Conv2d(r,o,a)},DepthwiseConv2d:(r,t,a)=>{let o={weights:new Float32Array(a.kernel*a.kernel*r.c),bias:new Float32Array(r.c)};return u.ops.DepthwiseConv2d(r,o,a)},Conv2dAdd:(r,t,a,o)=>{let n={weights:new Float32Array(o.kernel*o.kernel*r.c*o.outChannels),bias:new Float32Array(o.outChannels)};return u.ops.Conv2dAdd(r,t,n,o)},UpsampleConv1x1:(r,t,a)=>{let o={weights:new Float32Array(r.c*a.outChannels),bias:new Float32Array(a.outChannels)};return u.ops.UpsampleConv1x1(r,o,a)},ProjResidual:(r,t,a,o)=>{let n={weights:new Float32Array(r.c*o.outChannels),bias:new Float32Array(o.outChannels)};return u.ops.ProjResidual(r,t,n,o)},ConcatConv2d:(r,t,a,o)=>{let n={weights:new Float32Array(9*(r.c+t.c)*o.outChannels),bias:new Float32Array(o.outChannels)};return u.ops.ConcatConv2d(r,t,n,o)}},e}function Zn(){let u=new Proxy({},{get:()=>u});return u}async function eu(u,e){let r=J[e.model];if(!r)throw new Error(\`microbench: no TIER_CONFIG entry for '\${e.model}'\`);let t=r.base,a=Jn(u),o=a.tensor(r.baseRes.h,r.baseRes.w,4),n=new t(a,o,Zn());for(let l=0;l<Yn;l++)n.run(),await u.sync();let s=e.skipFrames+1,p=performance.now();for(let l=0;l<Ma;l++)l%s===0&&n.run();return await u.sync(),(performance.now()-p)/Ma}async function Ha(u,e,r){let t;if(u==="auto")t=await za(r);else if(typeof u=="string"){let a=ge(u);if(!a)throw new Error(\`resolve_preset: unknown preset name '\${u}'\`);t=a}else t=u;return t.dtype!==e?{...t,dtype:e}:t}function Na(u){let e=null,r=null;return u.onmessage=t=>{let{frame:a}=t.data;if(r){let o=r;r=null,o(a)}else e&&e.close(),e=a},u.start?.(),new ReadableStream({pull(t){if(e){t.enqueue(e),e=null;return}return new Promise(a=>{r=o=>{t.enqueue(o),a()}})},cancel(){e&&(e.close(),e=null),u.close()}},{highWaterMark:0})}function Va(u){switch(u.topology.input){case"mstp":if(!u.inputReadable)throw new Error("create_input: topology.input='mstp' but InitData.inputReadable missing");return u.inputReadable;case"rvfc-postmessage":if(!u.inputPort)throw new Error("create_input: topology.input='rvfc-postmessage' but InitData.inputPort missing");return Na(u.inputPort)}}function Xa(u){return new TransformStream({transform(e,r){u.process(e);let t=new VideoFrame(u.canvas,{timestamp:e.timestamp});e.close(),r.enqueue(t)}})}function ja(u){return new WritableStream({write(e){u.process(e),e.close()}})}function qa(u,e){return new WritableStream({write(r){u.process(r),r.close();let t=u.canvas.transferToImageBitmap();e.postMessage({bmp:t},[t])},close(){e.close()}})}var tu=Y("create_output");function $a(u,e,r){switch(u.topology.output){case"mstg":{if(!u.outputWritable)throw new Error("create_output: topology.output='mstg' but InitData.outputWritable missing");let t=Xa(e);return t.readable.pipeTo(u.outputWritable,{signal:r}).catch(a=>{r.aborted||tu.warn("mstg downstream pipe failed:",a)}),t.writable}case"transfer-capture":return ja(e);case"bitmap-shuttle":{if(!u.outputPort)throw new Error("create_output: topology.output='bitmap-shuttle' but InitData.outputPort missing");return qa(e,u.outputPort)}}}function Ka(u){if(!u.onFirstFrame)return u.input.pipeTo(u.output,{signal:u.signal});let e=!1,r=u.onFirstFrame,t=new TransformStream({transform(a,o){o.enqueue(a),e||(e=!0,queueMicrotask(r))}});return u.input.pipeThrough(t,{signal:u.signal}).pipeTo(u.output,{signal:u.signal})}var L=Y("worker");L("script loaded");var U=null,ue=null,ir=null;self.onmessage=async function(u){let{cmd:e,data:r,request_id:t}=u.data;L("cmd received:",e,"request_id:",t);try{let a=await ru(e,r);L("cmd ok:",e),du(t,a)}catch(a){L("cmd FAILED:",e,a),de("error",{message:\`\${e} failed: \${a.message??String(a)}\`,source:"worker",recoverable:!1,cause:a})}};async function ru(u,e){switch(u){case"init":return ou(e);case"startRender":return au(e.weights);case"setBackground":return iu(e);case"setEnabled":return su(e.enabled);case"setPreset":return cu(e);case"getStats":return U?.getStats()??null;case"destroy":return lu();case"attachPreview":return nu(e);case"setPreview":return uu(e);case"clearPreview":return pu();case"setTouchup":return gu(e);case"setReframe":return mu(e);case"reframeNow":return hu();default:throw new Error(\`unknown cmd: \${u}\`)}}async function ou(u){if(gr(!!u.debug),L("handleInit: start; topology=",u.topology,"preset=",u.preset,"backend=",u.backend,"dtype=",u.dtype),U)throw new Error("handleInit: already initialized");L("handleInit: setupBackend\\u2026");let e=await Oa(u,u.canvasSize,{onContextLost:o=>{L("GPU context lost:",o.message),de("error",o)}});L("handleInit: backend ready:",e.resolvedBackend,e.resolvedDtype,"canvas:",e.canvas.width,"x",e.canvas.height),L("handleInit: constructing Renderer (boot mode)\\u2026"),U=new Ae({backend:e.backend,backendKind:e.resolvedBackend,canvas:e.canvas,background:u.background,enabled:u.enabled,topology:u.topology}),ue=new AbortController,L("handleInit: createInputStream\\u2026");let r=Va(u);L("handleInit: createOutputSink\\u2026");let t=$a(u,U,ue.signal);L("handleInit: starting pipe (passthrough)\\u2026"),Ka({input:r,output:t,signal:ue.signal}).then(()=>{L("pipe completed (input ended)")}).catch(o=>{if(ue?.signal.aborted){L("pipe aborted (expected on destroy)");return}L("pipe FAILED:",o),de("error",{message:\`pipe failed: \${o.message}\`,source:"worker",recoverable:!1,cause:o})}),L("handleInit: resolvePreset\\u2026");let a=await Ha(u.preset,e.resolvedDtype,e.backend);return L("handleInit: preset resolved:",a),ir=a,L("handleInit: done; returning InitResponse, awaiting startRender"),{resolvedPreset:a,resolvedBackend:e.resolvedBackend,resolvedDtype:e.resolvedDtype}}async function au(u){if(L("handleStartRender: start; weights bytes:",u.byteLength),!U||!ir)throw new Error("handleStartRender: handleInit not completed");L("handleStartRender: attaching network via setPreset\\u2026"),U.setPreset(ir,u),L("handleStartRender: ready (effect mode active)"),de("ready",void 0)}async function iu(u){U?.setBackground(u)}async function su(u){U?.setEnabled(u)}async function nu(u){if(!U)throw new Error("handleAttachPreview: not initialized");U.attachPreview(u.canvas)}async function uu(u){if(!U)throw new Error("handleSetPreview: not initialized");U.setPreview(u.background,u.fps!==void 0?{fps:u.fps}:void 0)}async function pu(){U?.clearPreview()}async function cu(u){if(!U)throw new Error("handleSetPreset: not initialized");if(!u.weights)throw new Error("handleSetPreset: weights required for runtime preset swap");if(u.preset==="auto")throw new Error("handleSetPreset: 'auto' not supported on runtime swap (use at init for autotune)");let e=typeof u.preset=="string"?ge(u.preset)??fu(u.preset):u.preset;return U.setPreset(e,u.weights),{resolvedPreset:e}}async function lu(){ue?.abort(),ue=null,U?.destroy(),U=null,ir=null}function fu(u){throw new Error(\`handleSetPreset: unknown preset '\${u}'\`)}function du(u,e){let r={request_id:u,res:e};self.postMessage(r)}function de(u,e){let r={request_id:u,res:e};self.postMessage(r)}function Qy(u){de("stats",u)}function mu(u){if(!U)throw new Error("setReframe before init");U.setReframe(u)}function hu(){if(!U)throw new Error("reframeNow before init");U.reframeNow()}function gu(u){if(!U)throw new Error("setTouchup before init");U.setFaceEffects(u===null?null:{landmarkWeights:u.landmarkWeights,topology:{count:u.topoCount,uv:u.topoUv,idx:u.topoIdx,weightMask:u.weightMask},touchup:u.params})}export{Qy as emitStats};
`;var v=g("pipeline");function Oe(){{let t=new Blob([W],{type:"application/javascript"}),e=URL.createObjectURL(t),n=new Worker(e,{type:"module"});return URL.revokeObjectURL(e),n}}var U={strength:.6,amount:8,detail:.35,style:"freq-sep"},We=.15,pe="https://cdn.longpipe.dev/models/v/0.0.5/",Le={background:"blur",preset:"auto",weightsBaseUrl:pe,audio:"passthrough",enabled:true,adaptive:true,debug:false},oe={w:1280,h:720};function ze(t,e){if(e)return e;let r=t.getVideoTracks()[0]?.getSettings()??{};return {w:r.width||oe.w,h:r.height||oe.h}}function ue(t,e,n){let r=n==="f16"?".f16.bin":".bin";return `${t.replace(/\/$/,"")}/model_${e}${r}`}async function le(t,e,n){if(n==="f16"){let i=await fetch(ue(t,e,"f16"));if(i.ok)return i.arrayBuffer()}let r=ue(t,e,"f32"),a=await fetch(r);if(!a.ok)throw new Error(`weights fetch failed: ${a.status} ${r}`);return a.arrayBuffer()}async function He(t,e){let n=t.replace(/\/$/,""),r=(async()=>{if(e==="f16"){let c=await fetch(`${n}/model_landmark_mesh.f16.bin`);if(c.ok)return c.arrayBuffer()}let o=`${n}/model_landmark_mesh.bin`,l=await fetch(o);if(!l.ok)throw new Error(`touchup: landmark weights fetch failed: ${l.status} ${o}`);return l.arrayBuffer()})(),a=fetch(`${n}/face_topology.json`).then(o=>{if(!o.ok)throw new Error(`touchup: face_topology.json fetch failed: ${o.status}`);return o.json()}),i=fetch(`${n}/weight_mask.png`).then(async o=>{if(!o.ok)throw new Error(`touchup: weight_mask.png fetch failed: ${o.status}`);return createImageBitmap(await o.blob())}),[s,u,p]=await Promise.all([r,a,i]);return {landmarkWeights:s,topoCount:u.count,topoUv:new Float32Array(u.uv),topoIdx:new Float32Array(u.idx),weightMask:p}}var L=class{stream;ready;controller;worker;inputCleanup;outputCleanup;adaptive=null;denoiser=null;touchupAssets=null;weightsBaseUrl=pe;resolvedDtype="f32";bgCleanup=null;previewBgCleanup=null;constructor(e,n){let r={...Le,...n};z(r.debug);let a=$(),i=ne(a.input,e),s=ze(e,r.outputResolution),u=se(a.output,s);this.inputCleanup=i.cleanup,this.outputCleanup=u.cleanup;let p=j(r.audio),o;if(p.mode==="denoise"){let h=e.getAudioTracks()[0];h?(this.denoiser=new F(h,{model:p.denoise?.model??"auto",weightsBaseUrl:r.weightsBaseUrl,postFilterBeta:p.denoise?.postFilterBeta,gruLeak:p.denoise?.gruLeak,enabled:p.denoise?.enabled,onError:d=>r.onError?.({message:d,source:"audio",recoverable:true})}),o=this.denoiser.outputTrack):r.onError?.({message:'audio: "denoise" requested but the input stream has no audio track',source:"audio",recoverable:true});}this.stream=X(u.videoTrack,e,p,o),u.startPassthrough?.(e),this.worker=Oe(),this.controller=new D(this.worker),this.ready=new Promise((h,d)=>{this.controller.addPersistentListener("ready",()=>{v("ready handler invoked; resolving .ready"),r.onReady?.(),h();}),this.controller.addPersistentListener("error",f=>{console.error(`[longpipe/pipeline] error (${f.source}):`,f.message),f.recoverable||d(new Error(f.message)),r.onError?.(f);});});let l={topology:a,preset:r.preset,enabled:r.enabled,backend:"auto",dtype:r.dtype??"f16",canvasSize:s,debug:r.debug,...i.initFields,...u.initFields},c=[...i.transferList,...u.transferList];this.weightsBaseUrl=r.weightsBaseUrl,this.bootstrap(l,r.background,c,r.weightsBaseUrl,r.adaptive,r.onError,r.touchup,r.reframe);}async bootstrap(e,n,r,a,i,s,u,p){try{v("normalizing background\u2026");let o=await E(n);this.bgCleanup=o.cleanup??null;let l={...e,background:o.background},c=[...r,...o.transferList??[]];v("sending init\u2026");let h=await this.controller.sendMessage("init",l,c);v("init resolved:",h),v("fetching weights:",h.resolvedPreset.model,h.resolvedDtype);let d=await le(a,h.resolvedPreset.model,h.resolvedDtype);v("weights bytes:",d.byteLength),this.resolvedDtype=h.resolvedDtype,v("sending startRender\u2026"),await this.controller.sendMessage("startRender",{weights:d},[d]),v("startRender resolved; awaiting first frame"),p&&this.setReframe(p).catch(f=>{s?.({message:`reframe init failed: ${f.message??f}`,source:"unknown",recoverable:!0,cause:f});}),u&&this.setTouchup(u).catch(f=>{s?.({message:`touchup init failed: ${f.message??f}`,source:"unknown",recoverable:!0,cause:f});}),l.preset==="auto"&&i&&(this.adaptive=new P({backendKind:h.resolvedBackend,initialModel:h.resolvedPreset.model,fetchWeights:f=>le(a,f,h.resolvedDtype),getStats:()=>this.getStats(),swapPreset:async(f,R)=>{await this.controller.sendMessage("setPreset",{preset:f,weights:R},[R]);},onError:s}),this.adaptive.start());}catch(o){console.error("[longpipe/pipeline] bootstrap failed:",o),this.controller.handleMessage.call(this.controller,{data:{request_id:"error",res:{message:o.message??String(o),source:"worker",recoverable:false,cause:o}}});}}then(e,n){return this.ready.then(()=>e?e(this):this,n)}async setBackground(e){let n=await E(e),r=this.bgCleanup;this.bgCleanup=n.cleanup??null,await this.controller.sendMessage("setBackground",n.background,n.transferList),r?.();}async setTouchup(e){if(await this.ready,e===null){await this.controller.sendMessage("setTouchup",null);return}this.touchupAssets||(this.touchupAssets=await He(this.weightsBaseUrl,this.resolvedDtype));let n={strength:e.strength??U.strength,amount:e.amount??U.amount,detail:e.detail??U.detail,style:e.style??U.style,thresh:We};await this.controller.sendMessage("setTouchup",{...this.touchupAssets,params:n});}async setReframe(e){await this.ready;let n=e===true?{}:e===false||e===null?null:e;await this.controller.sendMessage("setReframe",n);}async reframe(){await this.ready,await this.controller.sendMessage("reframeNow",void 0);}setPreset(e,n){this.controller.sendMessage("setPreset",{preset:e,weights:n});}attachPreview(e){let n=e.transferControlToOffscreen();this.controller.sendMessage("attachPreview",{canvas:n},[n]);}async setPreview(e){let n=await E(e.background),r=this.previewBgCleanup;this.previewBgCleanup=n.cleanup??null,await this.controller.sendMessage("setPreview",{background:n.background,fps:e.fps},n.transferList),r?.();}clearPreview(){this.controller.sendMessage("clearPreview",{}),this.previewBgCleanup?.(),this.previewBgCleanup=null;}setEnabled(e){this.controller.sendMessage("setEnabled",{enabled:e});}async getStats(){return this.controller.sendMessage("getStats",{})}setDenoise(e){if(this.denoiser){if(typeof e=="boolean"){this.denoiser.setEnabled(e);return}(e.postFilterBeta!=null||e.gruLeak!=null)&&this.denoiser.setConfig({postFilterBeta:e.postFilterBeta,gruLeak:e.gruLeak}),e.enabled!=null&&this.denoiser.setEnabled(e.enabled);}}getAudioStats(){return this.denoiser?.getStats()??null}destroy(){this.adaptive?.stop(),this.adaptive=null,this.denoiser?.destroy(),this.denoiser=null,this.bgCleanup?.(),this.bgCleanup=null,this.previewBgCleanup?.(),this.previewBgCleanup=null,this.controller.sendMessage("destroy",{}),this.controller.terminate(),this.inputCleanup(),this.outputCleanup();}};
export{L as EffectsPipeline};