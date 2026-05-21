# Hetzner Cloud Firewall Rules

Apply these rules to the Hetzner CAX instance to secure the server and allow only necessary WebRTC and administrative traffic.

## Inbound Rules

| Direction | Protocol | Port Range    | Source IPs | Description                 |
| :---      | :---     | :---          | :---       | :---                        |
| In        | TCP      | 22            | Any        | SSH                         |
| In        | TCP      | 80            | Any        | HTTP (Certbot standalone)   |
| In        | TCP      | 443           | Any        | TURN TLS (HTTPS)            |
| In        | TCP      | 3478          | Any        | STUN/TURN (Clear)           |
| In        | UDP      | 3478          | Any        | STUN/TURN (Clear)           |
| In        | UDP      | 49152-65535   | Any        | WebRTC Media Relay (TURN)   |

## Outbound Rules

| Direction | Protocol | Port Range    | Destination IPs | Description             |
| :---      | :---     | :---          | :---            | :---                    |
| Out       | TCP      | Any           | Any             | Allow all outbound TCP  |
| Out       | UDP      | Any           | Any             | Allow all outbound UDP  |
