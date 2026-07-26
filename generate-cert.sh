#!/data/data/com.termux/files/usr/bin/bash
# Gumagawa ito ng self-signed HTTPS certificate.
# Kailangan ito kapag gusto mong ma-access ang camera/mic gamit ang
# IP address ng Termux device mo (halimbawa: https://192.168.1.5:3000)
# dahil hindi pinapayagan ng mga browser ang camera/mic sa plain HTTP
# maliban na lang kung "localhost" ang ginagamit.

echo "Gumagawa ng cert.pem at key.pem..."
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"

if [ -f cert.pem ] && [ -f key.pem ]; then
  echo ""
  echo "Tapos na! Pag pinatakbo mo ulit ang 'node server.js', gagamit na ito ng HTTPS."
  echo "Sa ibang device sa parehong WiFi, buksan ang: https://<IP-mo>:3000"
  echo "(Lalabas na 'hindi secure' warning ang browser dahil self-signed ang cert -"
  echo " normal lang ito, i-click lang ang 'Advanced' -> 'Proceed anyway')"
else
  echo "May error, hindi nagawa ang cert. I-check kung naka-install ang openssl (pkg install openssl-tool)."
fi
