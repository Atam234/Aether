# UMPAT Communication

Video call + chat web app, Messenger ang itsura, Termux ang server. Gumagana sa
loob ng LAN/WiFi at pwede ring i-expose sa Internet.

## Paano gumagana

- **Server**: Node.js (Express + Socket.io) — ito ang tatakbo sa Termux. Ginagawa
  lang nito ang "signaling" (pag-uugnay ng dalawang user) at ang text chat.
- **Video/Audio**: WebRTC — direktang kumokonekta ang dalawang browser sa isa't
  isa (peer-to-peer), kaya hindi dumadaan ang video/audio sa Termux server mo.
  Ang server, tulay lang para magkakilala ang dalawang device.

---

## 1. I-set up ang Termux

1. I-download ang **Termux mula sa F-Droid** (huwag ang bersyon sa Play Store,
   luma na yun): https://f-droid.org/packages/com.termux/
2. Buksan ang Termux at patakbuhin:
   ```
   pkg update && pkg upgrade
   pkg install nodejs openssl-tool
   ```

## 2. Ilipat ang mga file dito sa Termux

Kung na-download mo ang folder na `umpat-communication` sa Downloads ng phone mo:

```
termux-setup-storage
cp -r /sdcard/Download/umpat-communication ~/umpat-communication
cd ~/umpat-communication
```

## 3. I-install ang dependencies

```
npm install
```

## 4. (Importante) Gumawa ng HTTPS certificate

Hindi pinapayagan ng mga browser (Chrome, Firefox) ang camera/mic access kapag
plain HTTP at hindi "localhost" ang address — kailangan ng HTTPS. Kaya bago
mag-video call sa ibang device, patakbuhin muna ito **isang beses lang**:

```
bash generate-cert.sh
```

(Kapag hindi mo ito ginawa, gagana pa rin ang **text chat** pero hindi gagana
ang video call maliban kung `localhost` mismo ang ginagamit.)

## 5. Patakbuhin ang server

```
node server.js
```

Makikita mo sa terminal kung HTTP o HTTPS ang gamit ngayon.

## 6. Kunin ang IP address mo (para sa LAN)

Sa ibang Termux session o bagong terminal:

```
ip addr show wlan0
```

Hanapin ang parte na "inet 192.168.x.x" — yun ang IP mo.

## 7. Buksan sa browser

- **Sa parehong device (Termux mismo)**: `https://localhost:3000`
- **Sa ibang device, parehong WiFi/LAN**: `https://192.168.x.x:3000`
  (palitan ng aktwal na IP mo)

Lalabas na "Hindi Secure" warning ang browser dahil self-signed ang certificate
— normal lang ito. I-click lang: **Advanced → Proceed anyway / Continue to site**.

I-type ang pangalan mo, at makikita mo na sa listahan ang ibang naka-connect na
device sa parehong network. Pumili ng kontak, mag-chat o mag-video call.

---

## Paano gamitin sa Internet (hindi lang LAN)

Meron kang tatlong opsyon, mula sa pinaka-permanente hanggang sa pinaka-mabilis:

### Opsyon A: I-deploy sa Render gamit ang GitHub (rekomendado — libre, permanente, may sariling HTTPS)

Ito ang tamang paraan kung gusto niyong palaging accessible ang app kahit saan-saan
kayo, hindi na kailangang buksan ang Termux mo. Ang GitHub, imbakan lang ng code
(hindi ito server) — ang **Render.com** ang aktwal na magpapatakbo ng `server.js` mo,
24/7, libre, walang credit card na kailangan, at may sariling HTTPS na
awtomatiko — kaya hindi mo na kailangan pang gawin ang `generate-cert.sh`.

1. **Gumawa ng GitHub account** (kung wala pa) sa https://github.com, tapos gumawa
   ng bagong repository (hal. `umpat-communication`).
2. **I-upload ang buong folder** dito — pwede sa pamamagitan ng "Add file → Upload
   files" sa GitHub website (drag-and-drop lang), o kung may `git` ka:
   ```
   cd umpat-communication
   git init
   git add .
   git commit -m "Unang bersyon ng UMPAT Communication"
   git branch -M main
   git remote add origin https://github.com/<username-mo>/umpat-communication.git
   git push -u origin main
   ```
   (Salamat sa `.gitignore` na kasama, hindi isasama ang `node_modules` at ang
   mga lumang cert.pem/key.pem sa upload.)
3. **Pumunta sa** https://render.com **at mag-sign up** (pwede gamit ang GitHub
   account mo mismo, mas mabilis).
4. Sa Render dashboard: **New → Web Service**, tapos i-connect ang GitHub repo
   mong `umpat-communication`. May kasama nang `render.yaml` sa project na
   awtomatikong magse-set ng:
   - Build command: `npm install`
   - Start command: `node server.js`
   - Plan: Free
5. I-click ang **Deploy**. Maghihintay ka ng ilang minuto habang nagbi-build.
6. Kapag tapos na, may makukuha kang link tulad ng:
   `https://umpat-communication.onrender.com`
   Ito na ang ibibigay mo sa kausap mo — kahit saan sila sa mundo, basta may
   internet, puwede na silang mag-video call at mag-chat sa inyo.

**Mga dapat malaman sa Render free tier:**
- Awtomatiko nang HTTPS ang link — gagana agad ang camera/mic, walang extra
  setup.
- Kapag walang gumagamit sa loob ng ~15 minuto, "natutulog" muna ang service.
  Sa susunod na magbukas, ~1 minuto ang aabutin bago gumising — normal lang
  ito, hintayin lang.
- Tuwing may bagong commit/update sa GitHub repo mo, awtomatiko itong
  magde-deploy ulit sa Render.

### Opsyon B: Cloudflare Tunnel mula sa Termux (libre, pero pansamantala lang)

```
pkg install cloudflared
cloudflared tunnel --url http://localhost:3000
```

Bibigyan ka nito ng pampublikong link (hal. `https://random-name.trycloudflare.com`)
na pwede mong ibigay sa kausap mo kahit saan sila sa mundo — automatic na HTTPS
ito, kaya gagana rin ang camera/mic. **Note:** kung `cloudflared` ang ginamit,
hindi mo na kailangan ng sarili mong cert.pem/key.pem — patakbuhin na lang ang
server bilang plain HTTP (i-delete o palitan ng pangalan ang cert.pem/key.pem
kung gusto mong bumalik sa HTTP mode).

### Opsyon C: Port Forwarding sa Router

I-configure ang router mo na i-forward ang external port papunta sa
internal IP ng phone mo, port 3000. Mas komplikado ito at may security risk,
kaya Opsyon A (Render) ang mas rekomendado para sa karaniwang paggamit.

---

## Mga limitasyon na dapat malaman

- **In-memory lang ang listahan ng users** — kapag na-restart ang server,
  mawawala ang listahan (magre-reconnect naman ang mga users automatically).
- **Walang TURN server** — gumagamit lang ito ng public STUN server
  (`stun.l.google.com`). Sa karamihan ng LAN at ordinaryong internet
  connections, gagana ito, pero sa ibang strikto/corporate na network,
  posibleng hindi magkonekta ang video call dahil sa mahigpit na NAT/firewall.
- **Hindi ito naka-encrypt end-to-end sa text chat** (dumadaan ito sa server),
  pero ang video/audio mismo ay naka-encrypt na (built-in sa WebRTC/DTLS-SRTP).
- Ito ay para sa personal/small-group na gamit — hindi ito dinisenyo para sa
  malaking bilang ng sabay-sabay na users.

## Troubleshooting

| Problema | Solusyon |
|---|---|
| Walang lumalabas na ibang user sa listahan | Siguraduhing parehong network/WiFi ang mga device, at parehong URL (IP) ang ginamit nila |
| Hindi gumagana ang camera pag pinindot ang video call | Siguraduhing HTTPS ang ginamit (hindi plain http://IP), o gumamit ng Cloudflare Tunnel |
| "npm install" error sa Termux | Subukan ulit ang `pkg update && pkg upgrade`, siguraduhing bago ang Node.js version (`node -v`) |
| Nag-a-abort/nagsasara ang Termux session | Gamitin ang `termux-wake-lock` bago patakbuhin ang server para hindi ma-kill ng Android battery optimization |
