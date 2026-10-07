// src/audio.js — background-music downloads for slideshows (yt-dlp worker).
//
// Why this exists instead of YouTube embeds: the IFrame player refuses playback
// when the page origin is a bare-IP LAN address ("Error 153 / code 150", the
// unidentified-embedder wall), which kills every VEVO/partner-restricted track.
// So we stop embedding at show time: on save, the server fetches the audio ONCE
// with yt-dlp; the player then plays local files via <audio>. No embed policy,
// ad blocker, or internet flakiness can touch playback night-of.
//
// Design notes:
// - The binary is injectable (YTDL_BIN env) so tests stub it offline with a
//   shell script that honors the same --print contract.
// - One job per show at a time, in-process; status lives in SQLite because a
//   server restart mid-download must not lie about being 'downloading' forever.
// - Filenames are `<showId>_<videoId>.<ext>` — yt-dlp's %(id)s charset is
//   [A-Za-z0-9_-], and the serve route re-basenames + extension-whitelists, so
//   no path can escape the audio dir.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const YT_URL = /^(https?:\/\/)?((www|music|m)\.)?(youtube\.com|youtu\.be)\/\S+$/i;
const AUDIO_EXT = { m4a: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', mp3: 'audio/mpeg', ogg: 'audio/ogg' };

// One hard kill per job: a 50-track playlist stuck on a dead proxy must not
// hold the show in 'downloading' until the heat death of the container.
const JOB_TIMEOUT_MS = 60 * 60 * 1000;

// yt-dlp --print template, one line per finished track:
//   videoId|||duration|||title|||finalPath
// title sits third (may contain anything except what we re-join on) and path is
// LAST so it can be recovered with parts.at(-1); id/duration never contain the
// separator. --newline keeps lines flushed as they happen.
function printTemplate() {
  return '%(id)s|||%(duration)s|||%(title)s|||after_move:filepath';
}

class AudioJobs {
  /** @param {{db, audioDir: string, ytdlBin?: string}} opts */
  constructor({ db, audioDir, ytdlBin }) {
    this.db = db;
    this.audioDir = audioDir;
    this.ytdlBin = ytdlBin || process.env.YTDL_BIN || 'yt-dlp';
    this.active = new Set(); // showIds with a live child process (in-process truth)

    fs.mkdirSync(this.audioDir, { recursive: true });
    // Reconcile crash-orphaned status BEFORE anything reads it.
    db.run(
      `UPDATE slideshows SET audio_status='error', audio_error='download interrupted by server restart'
       WHERE audio_status='downloading'`,
      () => {}
    );
  }

  /** Kick off a download for showId, replacing any previous tracks. Returns {ok}|{error}. */
  start(showId, url) {
    if (!YT_URL.test(url)) return { error: 'only youtube.com / youtu.be URLs are supported' };
    if (this.active.has(showId)) return { ok: true, alreadyRunning: true };

    // Clear old tracks synchronously-enough (rows first, files best-effort):
    // a fresh save means the old playlist is wrong and must not half-play.
    this.db.all('SELECT filename FROM slideshow_tracks WHERE slideshow_id = ?', [showId], (err, rows) => {
      if (!err) for (const r of rows || []) fs.unlink(path.join(this.audioDir, path.basename(r.filename)), () => {});
      this.db.run('DELETE FROM slideshow_tracks WHERE slideshow_id = ?', [showId], () => {});
    });
    this.db.run(`UPDATE slideshows SET audio_status='downloading', audio_error='' WHERE id=?`, [showId]);

    const child = this._spawn(showId, url);
    this.active.add(showId);

    let tracksDone = 0;
    const stderrTail = { buf: '' };
    child.stdout.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        const t = this._parseTrackLine(line.trim());
        if (!t) continue;
        tracksDone++;
        this._insertTrack(showId, t, tracksDone - 1);
      }
    });
    child.stderr.on('data', (d) => { stderrTail.buf = (stderrTail.buf + String(d)).slice(-2000); });

    const timer = setTimeout(() => child.kill('SIGTERM'), JOB_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      this.active.delete(showId);
      if (code === 0 && tracksDone > 0) {
        this.db.run(`UPDATE slideshows SET audio_status='ready', audio_error='' WHERE id=?`, [showId]);
      } else if (code === 0) {
        // yt-dlp exited clean but printed nothing parseable — surface it loudly.
        this._fail(showId, 'download produced no audio files');
      } else {
        this._fail(showId, (stderrTail.buf.match(/ERROR: (.+)/g) || ['yt-dlp exit code ' + code]).pop().slice(7));
      }
    });
    child.on('error', (e) => { // binary missing → spawn itself fails, close may not fire
      clearTimeout(timer);
      this.active.delete(showId);
      this._fail(showId, `cannot run yt-dlp: ${e.message}`);
    });
    return { ok: true };
  }

  _spawn(showId, url) {
    const outTpl = path.join(this.audioDir, `${showId}_%(id)s.%(ext)s`);
    // Playlists are capped so one "playlist" save can't fork a day-long job;
    // singles ignore it. m4a/AAC because Safari refuses to decode opus-in-webm
    // and this app lives on iPhones as much as on desktops.
    const args = [
      '-f', 'bestaudio/best',
      '--extract-audio', '--audio-format', 'm4a', '--audio-quality', '128K',
      '--max-playlist-items', '50',
      // Playlist param → fetch the whole list; a bare watch link (even with an
      // incidental &list=) stays a single track. Mutually exclusive flags.
      ...(url.includes('list=') ? ['--yes-playlist'] : ['--no-playlist']),
      '-o', outTpl,
      '--newline', '--no-warnings', '--print', printTemplate(),
      url,
    ];
    return spawn(this.ytdlBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  _parseTrackLine(line) {
    if (!line || !line.includes('|||')) return null;
    const parts = line.split('|||');
    if (parts.length < 4) return null;
    const [videoId, duration, filepath] = [parts[0], parts[1], parts.at(-1)];
    const title = parts.slice(2, -1).join('|||');
    const filename = path.basename(filepath); // our template guarantees a flat name
    if (!filename || !AUDIO_EXT[filename.split('.').pop()?.toLowerCase()]) return null;
    return { videoId, title, duration: Number(duration) || null, filename };
  }

  _insertTrack(showId, t, position) {
    this.db.run(
      `INSERT INTO slideshow_tracks (id, slideshow_id, filename, title, duration, position) VALUES (?,?,?,?,?,?)`,
      [crypto.randomUUID(), showId, t.filename, String(t.title).slice(0, 280), t.duration, position],
      () => {}
    );
  }

  _fail(showId, msg) {
    this.db.run(`UPDATE slideshows SET audio_status='error', audio_error=? WHERE id=?`,
      [String(msg).slice(0, 300), showId]);
    console.log(`[slideshow-audio] show ${showId} failed: ${msg}`);
  }

  /** Remove all downloaded audio for a show (empty music_url / delete show). */
  clear(showId) {
    this.db.all('SELECT filename FROM slideshow_tracks WHERE slideshow_id = ?', [showId], (err, rows) => {
      if (!err) for (const r of rows || []) fs.unlink(path.join(this.audioDir, path.basename(r.filename)), () => {});
      this.db.run('DELETE FROM slideshow_tracks WHERE slideshow_id = ?', [showId], () => {});
    });
    this.db.run(`UPDATE slideshows SET audio_status='none', audio_error='' WHERE id=?`, [showId]);
  }
}

module.exports = { AudioJobs, YT_URL, AUDIO_EXT };
