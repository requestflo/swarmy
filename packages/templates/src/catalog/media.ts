import type { AppTemplate } from '../types';

// There is no host media mount in one-click templates: each app keeps its
// library on a named volume, and the notes / postDeploy say how to fill it.

export const MEDIA_TEMPLATES: AppTemplate[] = [
  {
    id: 'jellyfin',
    name: 'Jellyfin',
    tagline: 'Free media server for your movies, shows and music',
    category: 'media',
    icon: 'jellyfin',
    website: 'https://jellyfin.org',
    version: '12.1',
    imageHealthcheck: ['jellyfin'],
    heavyReason: 'Video transcoding runs on the CPU (no GPU) and wants 1.5 GB of RAM or more',
    postDeploy: [
      'Open <url> and run the setup wizard: create the admin account, then add a library pointing at /media.',
      'Copy your files into the media volume (for example docker cp ./Movies <container>:/media/ on the node running the service), then run Scan All Libraries in the dashboard.',
    ],
    notes: [
      'Media lives on the named media volume, not a host folder. Copy files in with docker cp on the node, or download them from a terminal in the service.',
      'There is no GPU passthrough, so transcoding is software-only. Direct play (clients that support the file format) avoids transcoding entirely.',
    ],
    yaml: `version: 1
app: jellyfin
services:
  jellyfin:
    image: jellyfin/jellyfin:12.1
    port: 8096
    memory: 1536mb
    env:
      JELLYFIN_PublishedServerUrl: \${{ app.url }}
    volumes:
      config: /config
      cache: /cache
      media: /media
`,
  },
  {
    id: 'navidrome',
    name: 'Navidrome',
    tagline: 'Stream your music collection from anywhere, Subsonic-compatible',
    category: 'media',
    icon: 'lucide:music',
    website: 'https://www.navidrome.org',
    version: '0.64.1',
    postDeploy: [
      'Open <url> and create the admin account (the first user becomes the admin).',
      'Copy your music into the music volume (for example docker cp ./Music/. <container>:/music/ on the node running the service); Navidrome picks it up on the next scan, or start one from the Activity menu.',
      'Point any Subsonic app (DSub, Symfonium, play:Sub and so on) at <url>.',
    ],
    notes: ['Music lives on the named music volume, not a host folder. Copy files in with docker cp on the node, or download them from a terminal in the service.'],
    yaml: `version: 1
app: navidrome
services:
  navidrome:
    image: deluan/navidrome:0.64.1
    port: 4533
    memory: 256mb
    env:
      ND_MUSICFOLDER: /music
      ND_DATAFOLDER: /data
    volumes:
      data: /data
      music: /music
    healthcheck:
      path: /ping
      interval: 30s
      timeout: 5s
      start_period: 30s
`,
  },
  {
    id: 'audiobookshelf',
    name: 'Audiobookshelf',
    tagline: 'Self-hosted audiobook and podcast server with mobile apps',
    category: 'media',
    icon: 'audiobookshelf',
    website: 'https://www.audiobookshelf.org',
    version: '2.36.1',
    postDeploy: [
      'Open <url> and create the root user.',
      'Add a library with folder /audiobooks (or /podcasts for a podcast library).',
      'Upload books from the browser with the Upload button, or copy them into the audiobooks volume with docker cp on the node.',
    ],
    notes: ['Books and podcasts live on named volumes, not a host folder. The built-in web upload is the easiest way in.'],
    yaml: `version: 1
app: audiobookshelf
services:
  audiobookshelf:
    image: ghcr.io/advplyr/audiobookshelf:2.36.1
    port: 80
    memory: 384mb
    volumes:
      config: /config
      metadata: /metadata
      audiobooks: /audiobooks
      podcasts: /podcasts
    healthcheck:
      path: /healthcheck
      interval: 30s
      timeout: 5s
      start_period: 30s
`,
  },
  {
    id: 'kavita',
    name: 'Kavita',
    tagline: 'Fast reading server for manga, comics and ebooks',
    category: 'media',
    icon: 'lucide:book-open',
    website: 'https://www.kavitareader.com',
    version: '0.9.1',
    imageHealthcheck: ['kavita'],
    postDeploy: [
      'Open <url> and register the admin account (the first user becomes the admin).',
      'Copy your books into the library volume (for example docker cp ./Manga <container>:/library/ on the node running the service), then add a library pointing at /library and scan it.',
    ],
    notes: ['Books live on the named library volume, not a host folder. Copy files in with docker cp on the node, or download them from a terminal in the service.'],
    yaml: `version: 1
app: kavita
services:
  kavita:
    image: jvmilazz0/kavita:0.9.1
    port: 5000
    memory: 512mb
    volumes:
      config: /kavita/config
      library: /library
`,
  },
];
