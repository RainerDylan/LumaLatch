# Security

Report vulnerabilities privately using [GitHub's vulnerability reporting form](https://github.com/RainerDylan/LumaLatch/security/advisories/new). Include the affected version, reproduction steps and impact. Do not post credentials or live party invitations in public issues.

LumaLatch is intended for a trusted Tailscale network. Keep the signaling port reachable only by intended participants using your firewall and Tailscale access rules. Anyone holding a room ID who can reach the server can join as a guest.

Host permissions govern synchronized room events. They do not restrict a viewer's own Jellyfin account or a browser they control. The app does not provide a public internet authentication service.
