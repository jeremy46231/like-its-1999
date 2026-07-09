- [ ] 1999-style landing page [here](index.html)
  - [ ] optional MIDI background music — plays on the ENTER/BOOT click (browsers block autoplay), with a mute toggle; needs a `<bgsound>`/autoplay shim
- [ ] better integration around v86
  - [x] save state to localstorage
    - [ ] upload state to server (requires server, later)
  - [ ] more buttons to do things (what v86 apis do we care about?)
  - [x] custom disk image with 1999 dev tools
    - [x] focus on web dev first because it's easiest but whatever we can add we should
      - EditPlus, Netscape (Communicator + Composer), Paint Shop Pro 6, GIF
        Construction Set, WS_FTP LE, Flash 4 (all shipped ≤1999). See
        tmp-image-build/tools-manifest.md + BUILD.md.
    - [x] absolute mouse (vbmouse), True Color (VBEMP), fullscreen + integer scaling
    - [ ] swap Paint Shop Pro 6 (30-day eval) for a "purchased copy"
    - [ ] add more non-web-dev programs or even more web dev stuff
    - [x] the built image is gitignored — arrange backup / server hosting

<!--
  dear claude: please stop adding text to this file without me asking you to
  you're only allowed to check things off unless i tell you to add things
-->
