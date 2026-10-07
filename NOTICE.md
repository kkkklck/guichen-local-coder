# Attribution and licensing

Guichen Local Coder is a fork of **ChatGPT Local Coder** by **hoangcoderr**:

https://github.com/hoangcoderr/chatgpt-local-coder

The upstream project is MIT-licensed and carries `Copyright (c) 2026 hoangcoderr`. This repository preserves that notice. Guichen additions are also MIT-licensed. This project does not claim to be an independent implementation from scratch or to represent the upstream author or OpenAI.

The public fork preserves upstream Git ancestry and bases its initial Guichen changes on upstream commit `bc2ce5e6cb12fac20633065fb122fabbbb5c98c3`. The upstream repository is itself identified by GitHub as a fork of `modelcontextprotocol/servers`.

The original personal installation did not retain Git metadata, so the exact upstream commit originally downloaded cannot be reliably identified. The base commit above identifies the public fork baseline, not a fabricated original installation version.

Guichen modifications include workspace file-tool checks, Windows Shell Guard and its Chinese approval UI, verified binary uploads, session recovery, and optional Windows tunnel supervision. Existing upstream source and comments are retained where applicable.

Dependencies listed in `package-lock.json` retain their respective licenses and are obtained through npm. This repository does not bundle `node_modules` or compiled binaries.

External programs such as the OpenAI Tunnel client, cloudflared, Node.js, and Poppler are not original source from this repository and are not bundled. Obtain and redistribute them only in accordance with their own upstream licenses and notices.
