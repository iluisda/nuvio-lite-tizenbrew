/* Nuvio Lite — app para Samsung UN49MU6100 (Tizen 3.0, Chromium M47). ES5 puro. */
(function () {
'use strict';

var BRIDGE = (window.BRIDGE_URL || 'http://192.168.0.100:7070');

// Kody klawiszy pilota Samsung
var KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, RETURN: 10009,
    BACK: 461, PLAY: 415, PAUSE: 19, STOP: 413, PLAYPAUSE: 10252,
    FF: 417, RW: 412, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406, INFO: 457 };

var view = 'home';           // home | collection | folder | detail | streams | player | search
var detailFrom = 'home';     // vista a la que vuelve el detalle
var homeRows = [];           // [{def, title, items, el, track, loading, done}]
var homeDefs = [];           // definiciones de filas (/api/home)
var homeLoaded = 0;
var homeBatch = 8;
var homeR = 0, homeC = 0;    // fokus na home
var detailFocus = [];        // lista fokusowalnych w detalu
var detailIdx = 0;
var currentMeta = null;
var currentSeason = 1;
var episodesCache = {};
var streams = [];
var streamIdx = 0;
var searchQuery = '';
var searchItems = [];
var searchIdx = 0;
var resumeMs = 0;            // pozycja wznowienia (żądana)
var pendingSeekMs = 0;       // przewinięcie do wykonania gdy odtwarzacz już gra
var playCtx = null;          // { contentId, type, season, episode } — do zapisu postępu
var progressTimer = null;

function $(id) { return document.getElementById(id); }
function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function show(v) {
    var ids = ['login', 'home', 'library', 'detail', 'streams', 'player', 'search', 'collection', 'folder', 'catalog', 'settings'];
    for (var i = 0; i < ids.length; i++) $('view-' + ids[i]).className = 'view' + (ids[i] === v ? '' : ' hidden');
    view = v;
    if (v === 'login' || v === 'player' || v === 'detail') navFocus = false;
    var sb = $('sidebar');
    if (sb) sb.className = (v === 'login' || v === 'player') ? 'hidden' : '';
    if (sb) renderNav();
}
function loader(on, txt) { $('loader').className = on ? '' : 'hidden'; $('loader-text').innerHTML = txt || 'Cargando...'; }

// ---------- HTTP (XHR, bo brak fetch na tym WebKicie) ----------
function get(url, cb, err) {
    var x = new XMLHttpRequest();
    x.open('GET', url, true);
    x.timeout = 45000;
    x.onreadystatechange = function () {
        if (x.readyState === 4) {
            if (x.status >= 200 && x.status < 300) {
                try { cb(JSON.parse(x.responseText)); } catch (e) { if (err) err(e); }
            } else if (err) err(new Error('HTTP ' + x.status));
        }
    };
    x.ontimeout = function () { if (err) err(new Error('timeout')); };
    x.onerror = function () { if (err) err(new Error('network')); };
    x.send();
}
function post(url, body, cb, err) {
    var x = new XMLHttpRequest();
    x.open('POST', url, true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.timeout = 20000;
    x.onreadystatechange = function () {
        if (x.readyState === 4) {
            if (x.status >= 200 && x.status < 300) { try { cb && cb(x.responseText ? JSON.parse(x.responseText) : {}); } catch (e) { cb && cb({}); } }
            else if (err) err(new Error('HTTP ' + x.status));
        }
    };
    x.onerror = function () { if (err) err(new Error('network')); };
    x.send(JSON.stringify(body || {}));
}

// ---------- Logowanie do konta Nuvio ----------
var loginTimer = null;
function startLogin() {
    show('login');
    $('login-status').innerHTML = 'Generando código...';
    $('login-qr-img').style.display = 'none';
    get(BRIDGE + '/me/login/start', function (d) {
        $('login-url').innerHTML = 'nuvio.tv/tv-login';
        $('login-code').innerHTML = 'Código: ' + d.code;
        $('login-status').innerHTML = 'Esperando a que confirmes el inicio de sesión en el teléfono...';
        var qr = BRIDGE + '/img?u=' + encodeURIComponent('https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=' + encodeURIComponent(d.url));
        var im = $('login-qr-img'); im.src = qr; im.style.display = 'block';
        pollLogin();
    }, function () { $('login-status').innerHTML = 'Error de conexión con el servidor. Reintentando...'; setTimeout(startLogin, 4000); });
}
function pollLogin() {
    if (loginTimer) clearTimeout(loginTimer);
    get(BRIDGE + '/me/login/poll', function (d) {
        if (d.status === 'ok') { $('login-status').innerHTML = '¡Sesión iniciada! Cargando tu cuenta...'; enterApp(); return; }
        loginTimer = setTimeout(pollLogin, 3000);
    }, function () { loginTimer = setTimeout(pollLogin, 4000); });
}
function enterApp() {
    show('home');
    loader(true, 'Cargando tu biblioteca...');
    buildHome();
}

// ---------- Barra lateral (navegación, estilo Nuvio) ----------
var navIdx = 0, navFocus = false;

function navItems() { return document.querySelectorAll('#nav .nav-item'); }

function renderNav() {
    var items = navItems();
    var active = (view === 'home' || view === 'catalog') ? 0 : (view === 'library' ? 1 : (view === 'search' ? 2 : (view === 'settings' ? 3 : -1)));
    for (var i = 0; i < items.length; i++) {
        items[i].className = 'nav-item' + (i === active ? ' active' : '') +
            (navFocus && i === navIdx ? ' focused' : '');
        items[i].onclick = (function (n) {
            return function () { navIdx = n; navEnter(); };
        })(i);
    }
}
function setNavFocus(i) {
    if (i < 0) i = 0; if (i > 3) i = 3;
    navIdx = i; navFocus = true; renderNav();
}
function closeNav() { navFocus = false; renderNav(); }
function navEnter() {
    var i = navIdx;
    navFocus = false; renderNav();
    if (i === 0) { show('home'); focusHome(); }
    else if (i === 1) openLibrary();
    else if (i === 2) openSearch();
    else openSettings();
}
function keyNav(k) {
    if (k === KEY.DOWN) setNavFocus(navIdx + 1);
    else if (k === KEY.UP) setNavFocus(navIdx - 1);
    else if (k === KEY.ENTER) navEnter();
    else if (k === KEY.RIGHT || k === KEY.RETURN || k === KEY.BACK) {
        closeNav();
        if (view === 'home') setHomeFocus(homeR, homeC);
        else if (view === 'library') setLibraryFocus(libIdx);
        else if (view === 'search') setSearchFocus(searchIdx);
        else if (view === 'settings') setSettingsFocus(setIdx);
        else if (view === 'catalog') setCatalogFocus(catIdx);
    }
}

// ---------- Biblioteca local (guardados) ----------
var LIB_KEY = 'nuvio.lite.library.v1';
var libItems = [], libIdx = 0;

var libSynced = false, libDirty = false;
function libLoad(cb) {
    try {
        var raw = null;
        try { raw = localStorage.getItem(LIB_KEY); } catch (e) { raw = null; }
        libItems = raw ? JSON.parse(raw) : [];
    } catch (e2) { libItems = []; }
    if (!(libItems instanceof Array)) libItems = [];
    get(BRIDGE + '/me/library', function (d) {
        if (d && d.items instanceof Array) {
            var remote = d.items;
            if (libDirty && libItems.length) {
                var have = {};
                for (var r = 0; r < remote.length; r++) have[String(remote[r].id) + '|' + remote[r].type] = 1;
                for (var l = libItems.length - 1; l >= 0; l--) {
                    var lk = String(libItems[l].id) + '|' + libItems[l].type;
                    if (!have[lk]) remote.unshift(libItems[l]);
                }
            }
            libItems = remote;
            libSynced = true;
            libPersist();
            if (libDirty) { libDirty = false; libPush(); }
        }
        if (cb) cb();
    }, function () { if (cb) cb(); });
}
function libPersist() {
    try { localStorage.setItem(LIB_KEY, JSON.stringify(libItems)); } catch (e) {}
}
function libPush() {
    if (!libSynced) { libDirty = true; return; }
    post(BRIDGE + '/me/library', { items: libItems }, function () {}, function () {});
}
function libFind(id, type) {
    for (var i = 0; i < libItems.length; i++) {
        if (String(libItems[i].id) === String(id) && libItems[i].type === type) return i;
    }
    return -1;
}
function libToggle(item) {
    var i = libFind(item.id, item.type);
    if (i >= 0) { libItems.splice(i, 1); libPersist(); libPush(); toast('Quitado de Mi biblioteca'); return false; }
    libItems.unshift(item); libPersist(); libPush(); toast('Guardado en Mi biblioteca'); return true;
}
function metaToLib(m) {
    return {
        id: contentId(m), type: m.type, title: m.title || '', poster: m.poster || '',
        backdrop: m.backdrop || '', logo: m.logo || '', year: m.year || '',
        rating: m.rating || '', overview: m.overview || '', imdb: m.imdb || '',
        genres: m.genres || [], addedAt: Date.now()
    };
}
function openLibrary() {
    show('library');
    renderLibrary();
    libLoad(function () {
        renderLibrary();
        if (libItems.length) setLibraryFocus(0);
    });
}
function renderLibrary() {
    var g = $('library-grid-inner'); g.innerHTML = '';
    g.style.transform = 'translateY(0)'; g.style.webkitTransform = 'translateY(0)';
    $('lib-count').innerHTML = libItems.length
        ? (libItems.length + (libItems.length === 1 ? ' título guardado' : ' títulos guardados')) : '';
    $('lib-empty').className = libItems.length ? 'hidden' : '';
    for (var i = 0; i < libItems.length; i++) {
        (function (it, n) {
            var card = cardForItem(it);
            card.onclick = function () { libIdx = n; openDetail(it); };
            g.appendChild(card);
        })(libItems[i], i);
    }
}
function setLibraryFocus(i) {
    clearFocusAll();
    navFocus = false; renderNav();
    var cards = $('library-grid-inner').childNodes;
    if (!cards.length) return;
    if (i < 0) i = 0; if (i >= cards.length) i = cards.length - 1;
    libIdx = i;
    cards[i].className = 'card focused';
    var row = Math.floor(i / 7);
    var off = row * gridPitch(cards, 7);
    var lgi = $('library-grid-inner');
    lgi.style.webkitTransform = 'translateY(' + (-off) + 'px)';
    lgi.style.transform = 'translateY(' + (-off) + 'px)';
}
function keyLibrary(k) {
    var n = libItems.length;
    if (!n) {
        if (k === KEY.RETURN || k === KEY.BACK || k === KEY.LEFT) { show('home'); focusHome(); }
        return;
    }
    var col = libIdx % 7;
    if (k === KEY.RIGHT) { if (libIdx + 1 < n) setLibraryFocus(libIdx + 1); }
    else if (k === KEY.LEFT) { if (col === 0) setNavFocus(1); else setLibraryFocus(libIdx - 1); }
    else if (k === KEY.DOWN) { if (libIdx + 7 < n) setLibraryFocus(libIdx + 7); }
    else if (k === KEY.UP) { if (libIdx - 7 >= 0) setLibraryFocus(libIdx - 7); else setNavFocus(0); }
    else if (k === KEY.ENTER) { var it = libItems[libIdx]; if (it) openDetail(it); }
    else if (k === KEY.RETURN || k === KEY.BACK) { show('home'); focusHome(); }
}

// ---------- Hero cinematográfico de la home ----------
var heroCache = {}, heroTimer = null, heroLayer = 0, heroToken = 0;
var ICO_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
var ICO_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
var ICO_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
var ICO_EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';

function heroMetaLine(m) {
    var a = [];
    if (m.year) a.push(esc(m.year));
    if (m.rating) a.push('<span style="color:#fff">\u2605 ' + esc(m.rating) + '</span>');
    if (m.runtime) a.push(m.runtime + ' min');
    if (m.genres && m.genres.length) a.push(esc(m.genres.slice(0, 3).join(' \u00b7 ')));
    return a.join('&nbsp;&nbsp;\u2022&nbsp;&nbsp;');
}
function heroShow(d) {
    var a = $('hero-bg-' + (heroLayer === 0 ? 'a' : 'b'));
    var b = $('hero-bg-' + (heroLayer === 0 ? 'b' : 'a'));
    if (d.backdrop) {
        b.style.backgroundImage = 'url(' + d.backdrop + ')';
        b.style.opacity = '1'; a.style.opacity = '0';
        heroLayer = 1 - heroLayer;
    } else if (b.style.opacity !== '0') {
        a.style.opacity = '0'; b.style.opacity = '0';
    }
    $('hero-kind').innerHTML = d.kind || '';
    if (d.logo) {
        var lg = $('hero-logo');
        lg.onerror = function () {
            lg.className = 'hidden';
            $('hero-title').className = '';
            $('hero-title').innerHTML = esc(d.title || '');
        };
        lg.src = d.logo; lg.className = '';
        $('hero-title').className = 'hidden';
    } else {
        $('hero-logo').className = 'hidden';
        $('hero-title').className = '';
        $('hero-title').innerHTML = esc(d.title || '');
    }
    $('hero-meta').innerHTML = d.meta || '';
    $('hero-overview').innerHTML = d.overview ? esc(d.overview) : '';
    $('hero-copy').className = '';
}
function heroLoad(it) {
    if (!it) return;
    if (it.folder) {
        heroShow({ backdrop: it.cover || '', logo: it.logo || '', title: it.title || '',
            kind: 'Colecci\u00f3n', meta: '', overview: '' });
        return;
    }
    var type = it.type === 'series' ? 'series' : 'movie';
    var key = type + ':' + it.id;
    if (heroCache[key]) { heroShow(heroCache[key]); return; }
    var token = ++heroToken;
    get(BRIDGE + '/api/meta/' + type + '/' + it.id, function (m) {
        var d = {
            backdrop: m.backdrop || m.banner || '',
            logo: m.logo || '',
            title: m.title || it.title || '',
            kind: m.type === 'series' ? 'Serie' : 'Pel\u00edcula',
            meta: heroMetaLine(m),
            overview: m.overview || ''
        };
        heroCache[key] = d;
        if (token === heroToken) heroShow(d);
    }, function () {
        if (token !== heroToken) return;
        heroShow({ backdrop: '', logo: '', title: it.title || '', kind: it.type === 'series' ? 'Serie' : 'Pel\u00edcula',
            meta: it.year ? esc(it.year) : '', overview: '' });
    });
}
function updateHero(it) {
    if (heroTimer) { clearTimeout(heroTimer); heroTimer = null; }
    if (!it) return;
    if (it.folder) { heroLoad(it); return; }
    heroTimer = setTimeout(function () { heroLoad(it); }, 240);
}

// ---------- v1.3: ajustes, vistos, canales en vivo, catálogo, up-next ----------
var SET_KEY = 'nuvio.lite.settings.v1';
var settings = { subLang: 'pt-BR', subSize: 'md', autoNext: true };

function loadSettings() {
    try {
        var raw = localStorage.getItem(SET_KEY);
        var s = raw ? JSON.parse(raw) : {};
        for (var k in settings) if (s[k] != null) settings[k] = s[k];
    } catch (e) {}
    applySettings();
}
function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {}
    applySettings();
}
function applySettings() {
    var st = $('subtitle-text');
    if (st) st.className = settings.subSize === 'lg' ? 'sub-lg' : (settings.subSize === 'xl' ? 'sub-xl' : '');
}
function subLangLabel() {
    return settings.subLang === 'off' ? 'Desactivados' : settings.subLang === 'pt-BR' ? 'Portugu\u00e9s (BR)' :
        settings.subLang === 'es' ? 'Espa\u00f1ol' : 'Ingl\u00e9s';
}
function subSizeLabel() {
    return settings.subSize === 'lg' ? 'Grande' : settings.subSize === 'xl' ? 'Muy grande' : 'Normal';
}

// ---------- Vistos ----------
var WATCH_KEY = 'nuvio.lite.watched.v1';
var watchedMap = {};
function watchedLocalLoad() {
    try { watchedMap = JSON.parse(localStorage.getItem(WATCH_KEY) || '{}') || {}; } catch (e) { watchedMap = {}; }
}
function watchedLocalSave() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchedMap)); } catch (e) {}
}
function wKey(id, type, season, episode) {
    return String(id) + '|' + (type === 'series' ? ('s' + (season == null ? 0 : season) + 'e' + (episode == null ? 0 : episode)) : 'm');
}
function isWatched(id, type, season, episode) { return !!watchedMap[wKey(id, type, season, episode)]; }
function loadWatched(cb) {
    watchedLocalLoad();
    get(BRIDGE + '/me/watched', function (d) {
        var items = (d && d.items) || [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            watchedMap[wKey(it.id, it.type, it.season, it.episode)] =
                { id: it.id, type: it.type, title: it.title, season: it.season, episode: it.episode, watchedAt: it.watchedAt || Date.now() };
        }
        watchedLocalSave();
        if (cb) cb();
    }, function () { if (cb) cb(); });
}
function setWatched(item, on) {
    var key = wKey(item.id, item.type, item.season, item.episode);
    if (on) watchedMap[key] = { id: item.id, type: item.type, title: item.title, season: item.season, episode: item.episode, watchedAt: Date.now() };
    else delete watchedMap[key];
    watchedLocalSave();
    var body = on
        ? { add: [{ id: item.id, type: item.type, title: item.title, season: item.season, episode: item.episode }] }
        : { remove: [{ id: item.id, season: item.season, episode: item.episode }] };
    post(BRIDGE + '/me/watched', body, function () {}, function () {});
}
function toggleWatched(item, btn) {
    var on = !isWatched(item.id, item.type, item.season, item.episode);
    setWatched(item, on);
    if (btn) {
        btn.innerHTML = '<span class="ico">' + (on ? ICO_CHECK : ICO_EYE) +
            '</span><span class="lbl">' + (on ? 'Visto' : 'Marcar visto') + '</span>';
        btn.className = 'btn alt focused';
    }
    toast(on ? 'Marcado como visto' : 'Desmarcado');
    return on;
}
function contentId(m) {
    if (!m) return '';
    if (m.imdb) return m.imdb;
    var id = String(m.id || '');
    if (id.indexOf('tt') === 0) return id;
    if (m.type === 'movie' || m.type === 'series') return 'tmdb:' + id;
    return id;
}
function isChannelType(t) { return t === 'channel' || t === 'sport' || t === 'tv'; }

// ---------- Tarjetas comunes ----------
function cardClass(it) {
    if (it.folder) return 'card folder-card-sm';
    if (it.type === 'channel' || it.type === 'tv') return 'card folder-card-sm ch-card';
    if (it.type === 'collection') return 'card folder-card-sm';
    return 'card';
}
function cardForItem(it) {
    var card = el('div', cardClass(it));
    if (it.poster) {
        var im = el('img'); im.src = it.poster; bindImgFallback(im, card, it.title); card.appendChild(im);
    } else card.appendChild(el('div', 'noimg', esc(it.title)));
    if (it.rating) card.appendChild(el('div', 'badge', it.rating));
    if (it.type === 'collection') {
        var ov = el('div', 'fc-overlay');
        if (it.logo) { var lg = el('img', 'fc-logo'); lg.src = it.logo; ov.appendChild(lg); }
        else ov.appendChild(el('div', 'fc-title', esc(it.title)));
        card.appendChild(ov);
    } else if (it.type === 'channel' || it.type === 'tv') {
        var cov = el('div', 'fc-overlay');
        cov.appendChild(el('div', 'live-pill', 'EN VIVO'));
        cov.appendChild(el('div', 'fc-title', esc(it.title)));
        card.appendChild(cov);
    } else {
        card.appendChild(el('div', 'cap', esc(it.title)));
    }
    if (isWatched(it.id, it.type, it.season, it.episode)) card.appendChild(el('div', 'wbadge', '\u2713'));
    return card;
}
function openItem(it, list, idx) {
    if (!it) return;
    if (isChannelType(it.type)) { startLive(it, list, idx); return; }
    if (it.type === 'collection') { openAioCollection(it); return; }
    openDetail(it);
}

// ---------- Canales en vivo ----------
var liveCtx = null, liveList = [], liveIdx = 0, hlsPlayer = null;
function startLive(it, list, idx) {
    liveList = (list && list.length) ? list : [it];
    liveIdx = idx || 0;
    loader(true, 'Conectando con ' + (it.title || 'el canal') + '...');
    get(BRIDGE + '/api/streams/' + it.type + '/' + encodeURIComponent(it.id), function (d) {
        loader(false);
        var ss = (d && d.streams) || [];
        if (!ss.length) { toast('Canal sin se\u00f1al'); return; }
        liveCtx = { item: it };
        currentMeta = { id: it.id, type: it.type, title: it.title, imdb: it.imdb || null,
            poster: it.poster || '', backdrop: it.background || it.poster || '' };
        resumeMs = 0; pendingSeekMs = 0;
        playStream(ss[0], true);
    }, function () { loader(false); toast('Canal sin se\u00f1al'); });
}
function zapChannel(dir) {
    if (!liveCtx || !liveList.length) return;
    liveIdx = (liveIdx + dir + liveList.length) % liveList.length;
    startLive(liveList[liveIdx], liveList, liveIdx);
}

// ---------- Catálogo completo (Ver todo) ----------
var catDef = null, catItems = [], catIdx = 0, catSkip = 0, catLoading = false, catDone = false;
var GRID_COLS = 7;
function gridPitch(cards, cols) {
    if (cards.length > cols && cards[cols]) return cards[cols].offsetTop - cards[0].offsetTop;
    return 342;
}
function openCatalog(def) {
    catDef = def; catItems = []; catIdx = 0; catSkip = 0; catDone = false; catLoading = false;
    $('cat-title').innerHTML = esc(def.title || 'Cat\u00e1logo');
    $('cat-count').innerHTML = '';
    $('cat-grid-inner').innerHTML = '';
    $('cat-grid-inner').style.webkitTransform = 'translateY(0)'; $('cat-grid-inner').style.transform = 'translateY(0)';
    show('catalog');
    loadCatalogPage();
}
function loadCatalogPage() {
    if (!catDef || catLoading || catDone) return;
    catLoading = true;
    $('cat-count').innerHTML = 'Cargando...';
    get(BRIDGE + '/api/row?key=' + encodeURIComponent(catDef.key) + '&skip=' + catSkip, function (d) {
        var items = (d && d.items) || [];
        items = items.filter(function (x) { return x && x.id && x.title; });
        if (!items.length) catDone = true;
        catItems = catItems.concat(items);
        catSkip += items.length || 100;
        catLoading = false;
        renderCatalogGrid();
        $('cat-count').innerHTML = catItems.length + (catDone ? ' t\u00edtulos' : ' +');
        if (view === 'catalog') setCatalogFocus(catIdx);
    }, function () { catLoading = false; catDone = true; $('cat-count').innerHTML = 'Error al cargar'; });
}
function renderCatalogGrid() {
    var g = $('cat-grid-inner'); g.innerHTML = '';
    for (var i = 0; i < catItems.length; i++) {
        (function (it, n) {
            var card = cardForItem(it);
            card.onclick = function () { openItem(it, catItems, n); };
            g.appendChild(card);
        })(catItems[i], i);
    }
}
function setCatalogFocus(i) {
    clearFocusAll(); navFocus = false; renderNav();
    var cards = $('cat-grid-inner').childNodes;
    if (!cards.length) return;
    if (i < 0) i = 0; if (i >= cards.length) i = cards.length - 1;
    catIdx = i;
    cards[i].className = cardClass(catItems[i]) + ' focused';
    var row = Math.floor(i / GRID_COLS);
    var off = row * gridPitch(cards, GRID_COLS);
    var cgi = $('cat-grid-inner');
    cgi.style.webkitTransform = 'translateY(' + (-off) + 'px)';
    cgi.style.transform = 'translateY(' + (-off) + 'px)';
    if (i + GRID_COLS >= catItems.length - 1) loadCatalogPage();
}
function keyCatalog(k) {
    var n = catItems.length;
    if (!n) { if (k === KEY.RETURN || k === KEY.BACK) { show('home'); focusHome(); } return; }
    var col = catIdx % GRID_COLS;
    if (k === KEY.RIGHT) { if (catIdx + 1 < n) setCatalogFocus(catIdx + 1); }
    else if (k === KEY.LEFT) { if (col === 0) setNavFocus(0); else setCatalogFocus(catIdx - 1); }
    else if (k === KEY.DOWN) { if (catIdx + GRID_COLS < n) setCatalogFocus(catIdx + GRID_COLS); }
    else if (k === KEY.UP) { if (catIdx - GRID_COLS >= 0) setCatalogFocus(catIdx - GRID_COLS); else setNavFocus(0); }
    else if (k === KEY.ENTER) { openItem(catItems[catIdx], catItems, catIdx); }
    else if (k === KEY.RETURN || k === KEY.BACK) { show('home'); focusHome(); }
}

// ---------- Colecciones de addon (AIOMetadata) ----------
var folderMode = 'account';
function openAioCollection(it) {
    loader(true, 'Cargando ' + (it.title || 'colecci\u00f3n') + '...');
    get(BRIDGE + '/api/meta/collection/' + encodeURIComponent(it.id), function (m) {
        loader(false);
        var sources = (m && m.collection && m.collection.sources) || [];
        if (!sources.length) { toast('Colecci\u00f3n vac\u00eda'); return; }
        folderMode = 'aio';
        curColl = { id: it.id, title: m.title || it.title };
        curCollId = it.id;
        curFolder = { cid: null, id: it.id, title: m.title || it.title,
            heroBackdropUrl: m.backdrop || it.background || it.poster || '', titleLogoUrl: m.logo || '' };
        curTabs = [];
        for (var i = 0; i < sources.length; i++) {
            curTabs.push({ i: i, kind: 'addon', title: sources[i].type === 'series' ? 'Series' : 'Pel\u00edculas',
                addonId: m.addonId, catalogId: sources[i].catalogId, type: sources[i].type, genre: '' });
        }
        curTab = 0; tabFocus = 0; folderArea = 'grid'; gridIdx = 0;
        $('folder-hero-bg').style.backgroundImage = curFolder.heroBackdropUrl ? 'url(' + curFolder.heroBackdropUrl + ')' : 'none';
        var logo = $('folder-hero-logo');
        if (curFolder.titleLogoUrl) { logo.src = curFolder.titleLogoUrl; logo.className = 'fk-logo'; $('folder-hero-title').innerHTML = ''; }
        else { logo.className = 'hidden'; $('folder-hero-title').innerHTML = esc(curFolder.title); }
        renderFolderTabs();
        loadTab(0);
        show('folder');
    }, function () { loader(false); toast('No se pudo abrir la colecci\u00f3n'); });
}

// ---------- Ajustes (vista) ----------
var setIdx = 0;
function settingsModel() {
    return [
        { key: 'subLang', label: 'Subt\u00edtulos', value: subLangLabel(), options: ['pt-BR', 'es', 'en', 'off'] },
        { key: 'subSize', label: 'Tama\u00f1o de subt\u00edtulos', value: subSizeLabel(), options: ['md', 'lg', 'xl'] },
        { key: 'autoNext', label: 'Siguiente episodio autom\u00e1tico', value: settings.autoNext ? 'S\u00ed' : 'No', options: [true, false] },
        { key: 'sync', label: 'Sincronizar biblioteca', value: 'Ejecutar' },
        { key: 'about', label: 'Nuvio Lite', value: 'v1.3' }
    ];
}
function openSettings() { renderSettings(); show('settings'); setSettingsFocus(0); }
function renderSettings() {
    var list = $('set-list'); list.innerHTML = '';
    var rows = settingsModel();
    for (var i = 0; i < rows.length; i++) {
        var r = el('div', 'set-row');
        r.appendChild(el('span', null, esc(rows[i].label)));
        var val = String(rows[i].value);
        if (rows[i].options) val = '\u2039  ' + val + '  \u203a';
        r.appendChild(el('span', 'set-val', esc(val)));
        (function (n) { r.onclick = function () { setSettingsFocus(n); }; })(i);
        list.appendChild(r);
    }
    var hint = $('set-hint');
    if (!hint) { hint = el('div', null, ''); hint.id = 'set-hint'; $('view-settings').appendChild(hint); }
    hint.innerHTML = 'ARRIBA/ABAJO = mover&nbsp;&nbsp;\u00b7&nbsp;&nbsp;IZQUIERDA/DERECHA = cambiar';
}
function setSettingsFocus(i) {
    clearFocusAll(); navFocus = false; renderNav();
    var rows = $('set-list').childNodes;
    if (!rows.length) return;
    if (i < 0) i = 0; if (i >= rows.length) i = rows.length - 1;
    setIdx = i; rows[i].className = 'set-row focused';
}
function keySettings(k) {
    var rows = settingsModel();
    if (k === KEY.DOWN) setSettingsFocus(setIdx + 1);
    else if (k === KEY.UP) { if (setIdx === 0) setNavFocus(3); else setSettingsFocus(setIdx - 1); }
    else if (k === KEY.LEFT || k === KEY.RIGHT) {
        var r = rows[setIdx];
        if (!r || !r.options) return;
        var cur = settings[r.key];
        var pos = 0;
        for (var i = 0; i < r.options.length; i++) if (String(r.options[i]) === String(cur)) pos = i;
        pos = (pos + (k === KEY.RIGHT ? 1 : r.options.length - 1)) % r.options.length;
        settings[r.key] = r.options[pos];
        saveSettings();
        renderSettings(); setSettingsFocus(setIdx);
    }
    else if (k === KEY.ENTER) {
        if (rows[setIdx] && rows[setIdx].key === 'sync') {
            loader(true, 'Sincronizando biblioteca...');
            libLoad(function () { loader(false); toast('Biblioteca sincronizada: ' + libItems.length + ' t\u00edtulos'); });
        }
    }
    else if (k === KEY.RETURN || k === KEY.BACK) { show('home'); focusHome(); }
}

// ---------- Siguiente episodio (auto-next) ----------
var upNextData = null, upNextLeft = 0, upNextTimer = null, endTimer = null, nearEndDone = false;
function pickNextEpisode(eps, s, e, cb) {
    for (var i = 0; i < eps.length; i++) {
        if (Number(eps[i].episode) === e + 1) return cb({ season: s, episode: e + 1, name: eps[i].name || '' });
    }
    var seasons = (currentMeta && currentMeta.seasons) || [];
    var nextS = null;
    for (var j = 0; j < seasons.length; j++) {
        var sn = Number(seasons[j].season);
        if (sn > s && (nextS == null || sn < nextS)) nextS = sn;
    }
    if (nextS == null) return cb(null);
    get(BRIDGE + '/api/episodes/' + playCtx.tmdbId + '/' + nextS, function (d) {
        var list = (d && d.episodes) || [];
        episodesCache[nextS] = list;
        cb(list.length ? { season: nextS, episode: Number(list[0].episode) || 1, name: list[0].name || '' } : null);
    }, function () { cb(null); });
}
function nextEpisode(cb) {
    if (!playCtx || playCtx.type !== 'series') return cb(null);
    var s = Number(playCtx.season || 1), e = Number(playCtx.episode || 1);
    var list = episodesCache[s];
    if (list && list.length) return pickNextEpisode(list, s, e, cb);
    get(BRIDGE + '/api/episodes/' + playCtx.tmdbId + '/' + s, function (d) {
        var eps = (d && d.episodes) || [];
        episodesCache[s] = eps;
        pickNextEpisode(eps, s, e, cb);
    }, function () { cb(null); });
}
function showUpNext(next) {
    upNextData = next; upNextLeft = 5;
    $('upnext-title').innerHTML = 'T' + next.season + 'E' + next.episode + (next.name ? ' \u00b7 ' + esc(next.name) : '');
    var img = $('upnext-img');
    img.src = (currentMeta && (currentMeta.backdrop || currentMeta.poster)) || '';
    $('upnext-count').innerHTML = upNextLeft + 's';
    $('upnext').className = '';
    if (upNextTimer) clearInterval(upNextTimer);
    upNextTimer = setInterval(function () {
        upNextLeft--;
        $('upnext-count').innerHTML = Math.max(0, upNextLeft) + 's';
        if (upNextLeft <= 0) playUpNext();
    }, 1000);
}
function hideUpNext() {
    if (upNextTimer) { clearInterval(upNextTimer); upNextTimer = null; }
    upNextData = null;
    $('upnext').className = 'hidden';
}
function playUpNext() {
    var n = upNextData; if (!n) return;
    hideUpNext();
    playCtx.season = n.season; playCtx.episode = n.episode;
    currentSeason = n.season; resumeMs = 0; pendingSeekMs = 0;
    loader(true, 'Buscando el siguiente episodio...');
    loadStreams('series', playCtx.tmdbId, n.season, n.episode, true);
}
function endedPlayback() {
    if (liveCtx) return;
    if (settings.autoNext && playCtx && playCtx.type === 'series') {
        nextEpisode(function (n) { if (n) showUpNext(n); else stopPlayback(true); });
        return;
    }
    stopPlayback(true);
}
function startEndWatch() {
    nearEndDone = false;
    if (endTimer) clearInterval(endTimer);
    endTimer = setInterval(function () {
        if (view !== 'player' || menuOpen || liveCtx || nearEndDone) return;
        var pos = currentPos();
        if (duration > 120000 && pos > duration - 12000) { nearEndDone = true; endedPlayback(); }
    }, 2000);
}

// ---------- Subtítulos: idioma preferido ----------
function normLang(l) {
    l = String(l || '').toLowerCase();
    if (l.indexOf('pt') === 0 || l.indexOf('por') > -1 || l.indexOf('pob') > -1) return 'pt';
    if (l.indexOf('es') === 0 || l.indexOf('spa') > -1 || l.indexOf('esp') > -1) return 'es';
    if (l.indexOf('en') === 0 || l.indexOf('eng') > -1) return 'en';
    return l;
}
function applyPreferredSub() {
    if (!settings.subLang || settings.subLang === 'off') return false;
    var want = normLang(settings.subLang);
    for (var i = 0; i < extSubs.length; i++) {
        if (normLang(extSubs[i].lang) === want) {
            curSubKey = 'ext' + extSubs[i].url;
            if (avplay()) applyExternalSub(extSubs[i].url); else h5LoadSub(extSubs[i].url);
            return true;
        }
    }
    return false;
}

// ---------- Aviso flotante ----------
var toastTimer = null;
function toast(txt) {
    var t = $('toast');
    t.innerHTML = esc(txt); t.className = '';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'hidden'; }, 2200);
}

// ---------- Strona główna ----------
var CATS = [
    { id: 'trending-movie', title: 'Películas en tendencia' },
    { id: 'trending-tv', title: 'Series en tendencia' },
    { id: 'popular-movie', title: 'Películas populares' },
    { id: 'popular-tv', title: 'Series populares' },
    { id: 'top-movie', title: 'Películas mejor valoradas' },
    { id: 'top-tv', title: 'Series mejor valoradas' }
];

var SCALE = 1;
function clearFocusAll() {
    var f = document.querySelectorAll('.focused');
    for (var i = 0; i < f.length; i++) f[i].className = f[i].className.replace(' focused', '');
}
// mantiene visible el elemento enfocado dentro de su scroller (scrollTop programatico;
// scrollIntoView no funciona bien dentro del #app escalado en M47)
function bindImgFallback(img, card, title) {
    img.onerror = function () {
        card.innerHTML = '';
        card.appendChild(el('div', 'fc-fallback', esc(title)));
    };
}
function keepVisible(scroller, item) {
    if (!scroller || !item) return;
    var sr = scroller.getBoundingClientRect(), ir = item.getBoundingClientRect();
    var d = 0;
    if (ir.bottom > sr.bottom - 6) d = (ir.bottom - sr.bottom + 14) / (SCALE || 1);
    else if (ir.top < sr.top + 6) d = (ir.top - sr.top - 14) / (SCALE || 1);
    if (d) scroller.scrollTop += Math.round(d);
}

function buildHome() {
    var container = $('rows-inner');
    container.innerHTML = '';
    homeRows = []; homeDefs = []; homeLoaded = 0;
    container.style.transform = 'translateY(0)'; container.style.webkitTransform = 'translateY(0)';
    homeDefs.push({ kind: 'continue', title: 'Seguir viendo' });
    loadNextRows();
    get(BRIDGE + '/api/home', function (d) {
        var rows = (d && d.rows) || [];
        for (var i = 0; i < rows.length; i++) homeDefs.push(rows[i]);
        loadNextRows();
        if (view === 'home') focusHome();
    }, function () {
        for (var c = 0; c < CATS.length; c++) homeDefs.push({ kind: 'legacy', title: CATS[c].title, catalogId: CATS[c].id });
        loadNextRows();
        if (view === 'home') focusHome();
    });
    setTimeout(function () { if (view === 'home') focusHome(); }, 1500);
}

function addRowEl(def, index) {
    var container = $('rows-inner');
    var rowEl = el('div', 'row' + (def.kind === 'collection' ? ' row-collection' : ''));
    var title = el('div', 'row-title', def.title || '');
    var track = el('div', 'row-track');
    rowEl.appendChild(title); rowEl.appendChild(track);
    container.appendChild(rowEl);
    return { def: def, title: def.title || '', items: [], el: rowEl, track: track, loading: false, done: false };
}

function loadNextRows() {
    var n = 0;
    while (homeLoaded < homeDefs.length && n < homeBatch) {
        var def = homeDefs[homeLoaded];
        homeRows[homeLoaded] = addRowEl(def, homeLoaded);
        loadRow(homeLoaded);
        homeLoaded++; n++;
    }
}

function loadRow(i) {
    var row = homeRows[i];
    if (!row || row.loading || row.done) return;
    row.loading = true;
    renderRow(i);
    var def = row.def, url = null;
    if (def.kind === 'continue') url = BRIDGE + '/me/continue';
    else if (def.kind === 'collection') url = BRIDGE + '/api/collection?id=' + encodeURIComponent(def.collectionId);
    else if (def.kind === 'legacy') url = BRIDGE + '/api/catalog/' + def.catalogId;
    else if (def.kind === 'catalog') url = BRIDGE + '/api/row?key=' + encodeURIComponent(def.key);
    if (!url) return;
    get(url, function (data) {
        var items = (data && data.items) || [];
        if (def.kind === 'continue') {
            items = items.map(function (x) {
                return { id: x.tmdbId, type: x.type, title: x.title + (x.season ? '  S' + x.season + 'E' + x.episode : ''),
                    poster: x.poster, pct: x.pct, resume: x };
            });
        } else if (def.kind === 'collection') {
            var folders = (data && data.folders) || [];
            items = folders.map(function (f) {
                return { folder: true, id: f.id, title: f.title, cover: f.coverImageUrl || f.focusGifUrl || '',
                    logo: f.titleLogoUrl || '' };
            });
        } else {
            items = items.filter(function (x) { return x && x.id && x.title; });
        }
        row.items = items; row.loading = false; row.done = true;
        renderRow(i);
        if (view === 'home') setHomeFocus(homeR, homeC);
    }, function () { row.loading = false; row.done = true; renderRow(i); });
}

function renderRow(i) {
    var row = homeRows[i];
    if (!row) return;
    row.track.innerHTML = '';
    if (row.loading && !row.items.length) {
        row.track.appendChild(el('div', 'card loading-card', '<div class="spin small"></div>'));
        return;
    }
    var items = row.items;
    if (row.def.kind === 'continue') {
        items = items.filter(function (x) {
            var cid = (x.resume && x.resume.contentId) || x.id;
            var sn = x.resume ? x.resume.season : null, ep = x.resume ? x.resume.episode : null;
            return !isWatched(cid, x.type, sn, ep);
        });
        row.items = items;
    }
    if (!items.length) {
        if (row.def.kind === 'continue') row.el.style.display = 'none';
        else row.track.appendChild(el('div', 'row-empty', '(sin contenido)'));
        return;
    }
    for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var card;
        if (it.folder) {
            card = el('div', 'card folder-card-sm');
            if (it.cover) { var im2 = el('img'); im2.src = it.cover; bindImgFallback(im2, card, it.title); card.appendChild(im2); }
            else card.appendChild(el('div', 'fc-title', esc(it.title)));
            var fov = el('div', 'fc-overlay');
            fov.appendChild(el('div', 'fc-title', esc(it.title)));
            card.appendChild(fov);
        } else {
            card = cardForItem(it);
            if (it.pct) { var pr = el('div', 'progress'); pr.style.width = it.pct + '%'; card.appendChild(pr); }
        }
        (function (item, listIdx, def) {
            card.onclick = function () {
                if (item.resume) resumeItem(item.resume);
                else if (item.folder && def && def.collectionId) openFolder(def.collectionId, item);
                else openItem(item, items, listIdx);
            };
        })(it, k, row.def);
        row.track.appendChild(card);
    }
    if (row.def.kind === 'catalog' && row.def.key) {
        var more = el('div', 'card more-card');
        more.appendChild(el('div', 'more-inner', '<div class="more-cell"><div class="more-arrow">\u2192</div><div class="more-title">Ver todo</div></div>'));
        var moreItem = { more: row.def, title: 'Ver todo' };
        more.onclick = function () { openCatalog(row.def); };
        row.track.appendChild(more);
    }
}

function focusHome() {
    loader(false);
    if (homeR >= homeRows.length) homeR = 0;
    var guard = 0;
    while (homeRows[homeR] && homeRows[homeR].done && !homeRows[homeR].items.length && guard < homeRows.length) { homeR++; guard++; }
    if (homeR >= homeRows.length) homeR = 0;
    setHomeFocus(homeR, homeC);
}

function setHomeFocus(r, c) {
    clearFocusAll();
    if (!homeRows[r]) return;
    if (r >= homeLoaded - 3) loadNextRows();
    if (!homeRows[r].items.length) {
        var dir = r > homeR ? 1 : -1, rr = r, guard = 0;
        while (homeRows[rr] && !homeRows[rr].items.length && guard < homeRows.length) { rr += dir; guard++; }
        if (!homeRows[rr] || rr < 0) return;
        r = rr;
    }
    var extra = (homeRows[r].def && homeRows[r].def.kind === 'catalog' && homeRows[r].def.key) ? 1 : 0;
    var maxC = homeRows[r].items.length + extra - 1;
    if (c > maxC) c = maxC;
    if (c < 0) c = 0;
    homeR = r; homeC = c;
    var hv = $('view-home');
    if (hv) hv.className = 'view' + (r > 0 ? ' compact' : '');
    var cards = homeRows[r].track.childNodes;
    if (!cards[c]) return;
    var itFocus = homeRows[r].items[c] || { more: homeRows[r].def };
    var step = /folder-card-sm/.test(cardClass(itFocus)) ? 414 : 232;
    cards[c].className = cardClass(itFocus) + ' focused';
    homeRows[r].track.style.marginLeft = (-c * step) + 'px';
    scrollRowsTo(r);
    updateHero(homeRows[r].items[c]);
}

function scrollRowsTo(r) {
    var row = homeRows[r];
    var off = row ? Math.max(0, row.el.offsetTop) : 0;
    var inner = $('rows-inner');
    inner.style.webkitTransform = 'translateY(' + (-off) + 'px)';
    inner.style.transform = 'translateY(' + (-off) + 'px)';
}

// ---------- Colecciones y carpetas ----------
var curColl = null, curCollId = null, curFolder = null;
var curTabs = [], curTab = 0, folderItems = [], folderCache = {};
var collIdx = 0, collCols = 4, gridIdx = 0, gridCols = 7;
var folderArea = 'grid', tabFocus = 0;

function openCollection(cid, title) {
    curCollId = cid;
    if (curColl && curColl.id === cid && (curColl.folders || []).length) { renderCollection(); show('collection'); return; }
    loader(true, 'Cargando colecci\u00f3n...');
    get(BRIDGE + '/api/collection?id=' + encodeURIComponent(cid), function (d) {
        curColl = d || {}; curColl.id = curColl.id || cid;
        if (!curColl.title && title) curColl.title = title;
        renderCollection(); loader(false); show('collection');
    }, function () { loader(false); });
}

function renderCollection() {
    $('coll-title').innerHTML = esc(curColl.title || 'Colecci\u00f3n');
    var g = $('coll-grid'); g.innerHTML = '';
    var folders = curColl.folders || [];
    for (var i = 0; i < folders.length; i++) {
        var f = folders[i];
        var card = el('div', 'folder-card');
        var img = f.coverImageUrl || f.focusGifUrl || '';
        if (img) {
            var im = el('img'); im.src = img; bindImgFallback(im, card, f.title); card.appendChild(im);
            var ov = el('div', 'fc-overlay');
            if (f.titleLogoUrl) { var lg = el('img', 'fc-logo'); lg.src = f.titleLogoUrl; ov.appendChild(lg); }
            else ov.appendChild(el('div', 'fc-title', esc(f.title)));
            card.appendChild(ov);
        } else card.appendChild(el('div', 'fc-title', esc(f.title)));
        g.appendChild(card);
    }
    focusCollection(0);
}

function focusCollection(i) {
    clearFocusAll();
    var cards = $('coll-grid').childNodes;
    if (!cards.length) return;
    if (i < 0) i = 0;
    if (i >= cards.length) i = cards.length - 1;
    collIdx = i;
    cards[i].className = 'folder-card focused';
    keepVisible($('coll-grid'), cards[i]);
}

function keyCollection(k) {
    var n = $('coll-grid').childNodes.length;
    if (!n) { if (k === KEY.RETURN || k === KEY.BACK) show('home'); return; }
    if (k === KEY.RIGHT) focusCollection(collIdx + 1);
    else if (k === KEY.LEFT) focusCollection(collIdx - 1);
    else if (k === KEY.DOWN) focusCollection(collIdx + collCols);
    else if (k === KEY.UP) { if (collIdx < collCols) show('home'); else focusCollection(collIdx - collCols); }
    else if (k === KEY.ENTER) { var f = (curColl.folders || [])[collIdx]; if (f) openFolder(curColl.id, f); }
    else if (k === KEY.RETURN || k === KEY.BACK) show('home');
}

function openFolder(cid, f) {
    folderMode = 'account';
    curCollId = cid;
    loader(true, 'Cargando ' + f.title + '...');
    get(BRIDGE + '/api/folder?cid=' + encodeURIComponent(cid) + '&fid=' + encodeURIComponent(f.id), function (d) {
        curFolder = (d && d.folder) || { id: f.id, title: f.title };
        curFolder.cid = cid;
        curTabs = (d && d.tabs) || [];
        curTab = 0; tabFocus = 0; folderArea = 'grid'; gridIdx = 0;
        var bg = curFolder.heroBackdropUrl || f.coverImageUrl || f.cover || '';
        $('folder-hero-bg').style.backgroundImage = bg ? 'url(' + bg + ')' : 'none';
        var logo = $('folder-hero-logo');
        var logoUrl = f.titleLogoUrl || f.logo || '';
        if (logoUrl) { logo.src = logoUrl; logo.className = 'fk-logo'; $('folder-hero-title').innerHTML = ''; }
        else { logo.className = 'hidden'; $('folder-hero-title').innerHTML = esc(f.title); }
        renderFolderTabs();
        loadTab(0);
        if (!curColl || curColl.id !== cid) {
            get(BRIDGE + '/api/collection?id=' + encodeURIComponent(cid), function (dc) { if (dc && dc.id) curColl = dc; }, function () {});
        }
        loader(false); show('folder');
    }, function () { loader(false); });
}

function renderFolderTabs() {
    var t = $('folder-tabs'); t.innerHTML = '';
    for (var i = 0; i < curTabs.length; i++) {
        var cls = 'ftab' + (i === curTab ? ' active' : '') + (folderArea === 'tabs' && i === tabFocus ? ' focused' : '');
        t.appendChild(el('div', cls, esc(curTabs[i].title)));
    }
    t.style.marginLeft = (-Math.max(0, tabFocus - 3) * 250) + 'px';
}

var folderSkip = 0, folderPage = 1, folderLoading = false, folderDone = false;
function folderUrl(i, more) {
    if (folderMode === 'aio') {
        var t = curTabs[i];
        return BRIDGE + '/api/row?key=' + encodeURIComponent(t.addonId + ':' + t.type + ':' + t.catalogId) + '&skip=' + (more ? folderSkip : 0);
    }
    var base = BRIDGE + '/api/folderitems?cid=' + encodeURIComponent(curFolder.cid) + '&fid=' + encodeURIComponent(curFolder.id) + '&tab=' + i;
    if (curTabs[i] && curTabs[i].kind === 'tmdb') return base + '&page=' + (more ? folderPage : 1);
    return base + '&skip=' + (more ? folderSkip : 0);
}
function loadTab(i) {
    curTab = i;
    renderFolderTabs();
    folderSkip = 0; folderPage = 1; folderLoading = false; folderDone = false;
    var ckey = (curFolder ? curFolder.id : '') + '|' + i + '|' + folderMode;
    if (folderCache[ckey]) { folderItems = folderCache[ckey]; renderFolderGrid(); return; }
    folderItems = [];
    $('folder-grid').innerHTML = '<div class="grid-loading">Cargando\u2026</div>';
    get(folderUrl(i, false), function (d) {
        folderItems = (d && d.items) || [];
        folderSkip = folderItems.length;
        folderCache[ckey] = folderItems.slice(0);
        if (curTab === i) renderFolderGrid();
    }, function () { if (curTab === i) $('folder-grid').innerHTML = '<div class="grid-loading">Error al cargar la pesta\u00f1a.</div>'; });
}
function loadMoreFolder() {
    if (folderLoading || folderDone) return;
    folderLoading = true;
    var i = curTab;
    $('folder-grid').appendChild(el('div', 'grid-loading', 'Cargando m\u00e1s\u2026'));
    get(folderUrl(i, true), function (d) {
        var items = (d && d.items) || [];
        if (!items.length) folderDone = true;
        folderItems = folderItems.concat(items);
        folderSkip += items.length || 100;
        folderPage++;
        folderLoading = false;
        if (curTab === i) renderFolderGrid(true);
    }, function () { folderLoading = false; folderDone = true; if (curTab === i) renderFolderGrid(true); });
}

function renderFolderGrid(keep) {
    var g = $('folder-grid'); g.innerHTML = '';
    if (!folderItems.length) { g.innerHTML = '<div class="grid-loading">Sin contenido.</div>'; return; }
    for (var i = 0; i < folderItems.length; i++) {
        var it = folderItems[i];
        var card = cardForItem(it);
        card.onclick = (function (item) { return function () { openItem(item, folderItems, 0); }; })(it);
        g.appendChild(card);
    }
    if (keep) focusGrid(gridIdx); else { gridIdx = 0; focusGrid(0); }
}

function focusGrid(i) {
    folderArea = 'grid';
    clearFocusAll();
    var cards = $('folder-grid').childNodes;
    if (!cards.length || !cards[0].className) return;
    if (i < 0) i = 0;
    if (i >= cards.length) i = cards.length - 1;
    gridIdx = i;
    cards[i].className = 'card focused';
    keepVisible($('folder-grid'), cards[i]);
}

function keyFolder(k) {
    if (k === KEY.RETURN || k === KEY.BACK) {
        if (folderMode === 'aio') { show('home'); focusHome(); }
        else if (curColl) { renderCollection(); show('collection'); }
        else show('home');
        return;
    }
    if (folderArea === 'tabs') {
        if (k === KEY.LEFT) focusTab(tabFocus - 1);
        else if (k === KEY.RIGHT) focusTab(tabFocus + 1);
        else if (k === KEY.DOWN || k === KEY.ENTER) { loadTab(tabFocus); }
        return;
    }
    var n = folderItems.length;
    if (k === KEY.RIGHT) { if (gridIdx < n - 1) focusGrid(gridIdx + 1); }
    else if (k === KEY.LEFT) { if (gridIdx > 0) focusGrid(gridIdx - 1); }
    else if (k === KEY.DOWN) {
        if (gridIdx + gridCols < n) {
            focusGrid(gridIdx + gridCols);
            if (gridIdx + gridCols >= n - 1) loadMoreFolder();
        } else loadMoreFolder();
    }
    else if (k === KEY.UP) { if (gridIdx < gridCols) { folderArea = 'tabs'; tabFocus = curTab; renderFolderTabs(); } else focusGrid(gridIdx - gridCols); }
    else if (k === KEY.ENTER) { if (n) openDetail(folderItems[gridIdx]); }
}

function focusTab(i) {
    folderArea = 'tabs';
    if (i < 0) i = 0;
    if (i >= curTabs.length) i = curTabs.length - 1;
    tabFocus = i;
    renderFolderTabs();
}

// ---------- Szczegóły ----------
function openDetail(item) {
    if (view !== 'detail') detailFrom = view;
    resumeMs = 0; pendingSeekMs = 0;   // świeży tytuł = odtwarzanie od początku (nie dziedzicz pozycji wznawiania)
    loader(true, 'Cargando detalles...');
    get(BRIDGE + '/api/meta/' + item.type + '/' + item.id, function (meta) {
        currentMeta = meta;
        currentSeason = 1;
        episodesCache = {};
        renderDetail();
        loader(false);
        show('detail');
    }, function () { loader(false); });
}

function playCurrent() {
    var m = currentMeta;
    if (!m) return;
    if (m.type === 'movie') loadStreams('movie', m.id, null, null);
    else loadStreams('series', m.id, currentSeason, 1);
}
function saveCurrent() {
    if (!currentMeta) return false;
    return libToggle(metaToLib(currentMeta));
}

function renderDetail() {
    var m = currentMeta;
    $('detail-backdrop').style.backgroundImage = m.backdrop ? 'url(' + m.backdrop + ')' : 'none';
    $('detail-kind').innerHTML = m.type === 'series' ? 'Serie' : (isChannelType(m.type) ? 'En vivo' : 'Pel\u00edcula');
    $('detail-title').innerHTML = m.title;
    if (m.logo) {
        var dlg = $('detail-logo');
        dlg.onerror = function () {
            dlg.className = 'hidden';
            $('detail-title').className = '';
        };
        dlg.src = m.logo; dlg.className = '';
        $('detail-title').className = 'hidden';
    } else {
        $('detail-logo').className = 'hidden';
        $('detail-title').className = '';
    }
    var meta = [];
    if (m.year) meta.push(m.year);
    if (m.rating) meta.push('\u2605 ' + m.rating);
    if (m.runtime) meta.push(m.runtime + ' min');
    if (m.genres && m.genres.length) meta.push(m.genres.join(' \u00b7 '));
    $('detail-meta').innerHTML = meta.join('&nbsp;&nbsp;\u2022&nbsp;&nbsp;');
    $('detail-overview').innerHTML = m.overview || '';
    detailFocus = [];
    detailIdx = 0;

    var actions = $('detail-actions'); actions.innerHTML = '';
    var eps = $('detail-episodes'); eps.innerHTML = '';

    var playBtn = el('div', 'btn', '<span class="ico">' + ICO_PLAY + '</span><span class="lbl">Reproducir</span>');
    playBtn.onclick = playCurrent;
    actions.appendChild(playBtn);
    detailFocus.push({ el: playBtn, action: playCurrent });

    var saved = libFind(contentId(m), m.type) >= 0;
    var saveBtn = el('div', 'btn alt', '<span class="ico">' + (saved ? ICO_CHECK : ICO_PLUS) +
        '</span><span class="lbl">' + (saved ? 'En mi biblioteca' : 'Mi biblioteca') + '</span>');
    saveBtn.onclick = function () {
        var s = saveCurrent();
        saveBtn.innerHTML = '<span class="ico">' + (s ? ICO_CHECK : ICO_PLUS) +
            '</span><span class="lbl">' + (s ? 'En mi biblioteca' : 'Mi biblioteca') + '</span>';
        saveBtn.className = 'btn alt focused';
    };
    actions.appendChild(saveBtn);
    detailFocus.push({ el: saveBtn, action: function () { saveBtn.onclick(); } });

    var watchItem = { id: contentId(m), type: m.type, title: m.title, season: null, episode: null };
    var isSeen = isWatched(watchItem.id, watchItem.type);
    var seenBtn = el('div', 'btn alt', '<span class="ico">' + (isSeen ? ICO_CHECK : ICO_EYE) +
        '</span><span class="lbl">' + (isSeen ? 'Visto' : 'Marcar visto') + '</span>');
    seenBtn.onclick = function () { toggleWatched(watchItem, seenBtn); };
    actions.appendChild(seenBtn);
    detailFocus.push({ el: seenBtn, action: function () { seenBtn.onclick(); } });

    if (m.type === 'series') {
        var hint = el('div', 'ep-hint', 'Tecla AZUL del mando: marcar el episodio enfocado como visto');
        eps.appendChild(hint);
        // Zakładki sezonów
        var tabs = el('div', 'season-tabs');
        var seasons = m.seasons || [];
        for (var s = 0; s < seasons.length; s++) {
            (function (sn) {
                var tab = el('div', 'season-tab' + (sn === currentSeason ? ' active' : ''), 'Temporada ' + sn);
                tab.onclick = function () { currentSeason = sn; renderDetail(); focusDetail(0); };
                tabs.appendChild(tab);
                detailFocus.push({ el: tab, action: function () { currentSeason = sn; renderDetail(); focusDetail(0); } });
            })(seasons[s].season);
        }
        eps.appendChild(tabs);
        renderEpisodes(eps);
    }
    focusDetail(detailIdx);
}

function renderEpisodes(container) {
    var m = currentMeta;
    var list = el('div', 'ep-list');
    container.appendChild(list);
    function draw(episodes) {
        for (var i = 0; i < episodes.length; i++) {
            (function (ep) {
                var wItem = { id: contentId(m), type: 'series', title: m.title, season: currentSeason, episode: Number(ep.episode) };
                var seen = isWatched(wItem.id, 'series', wItem.season, wItem.episode);
                var row = el('div', 'ep' + (seen ? ' watched' : ''), '<span class="epnum">E' + ep.episode + '</span>' + esc(ep.name) +
                    (seen ? '<span class="wcheck">\u2713 Visto</span>' : ''));
                row.onclick = function () { loadStreams('series', m.id, currentSeason, ep.episode); };
                list.appendChild(row);
                detailFocus.push({ el: row, action: function () { loadStreams('series', m.id, currentSeason, ep.episode); }, ep: wItem });
            })(episodes[i]);
        }
        focusDetail(detailIdx);
    }
    if (episodesCache[currentSeason]) { draw(episodesCache[currentSeason]); return; }
    get(BRIDGE + '/api/episodes/' + m.id + '/' + currentSeason, function (data) {
        episodesCache[currentSeason] = data.episodes || [];
        draw(episodesCache[currentSeason]);
    });
}

function focusDetail(i) {
    clearFocusAll();
    if (i < 0) i = 0;
    if (i >= detailFocus.length) i = detailFocus.length - 1;
    detailIdx = i;
    if (detailFocus[i]) {
        var e = detailFocus[i].el;
        e.className += ' focused';
        if (e.parentNode && e.parentNode.className === 'ep-list') keepVisible($('detail-episodes'), e);
        else if (e.scrollIntoView) { try { e.scrollIntoView(false); } catch (x) {} }
    }
}

// ---------- Źródła ----------
function loadStreams(type, id, season, episode, autoFirst) {
    loader(true, 'Buscando fuentes en tus addons...');
    // kontekst do zapisu postępu na koncie (tmdbId potrzebne do zamiany na imdb -> sync między urządzeniami)
    if (!playCtx || playCtx.tmdbId != id) {
        playCtx = {
            contentId: (currentMeta && currentMeta.imdb) ? currentMeta.imdb : ('tmdb:' + id),
            tmdbId: id, type: type, season: season, episode: episode
        };
    } else {
        playCtx.type = type; playCtx.season = season; playCtx.episode = episode;
    }
    var url = BRIDGE + '/api/streams/' + type + '/' + id;
    var q = [];
    if (season != null) q.push('season=' + season);
    if (episode != null) q.push('episode=' + episode);
    if (q.length) url += '?' + q.join('&');
    get(url, function (data) {
        streams = data.streams || [];
        streamIdx = 0;
        if (autoFirst && streams.length) { loader(false); playStream(streams[0]); return; }
        renderStreams();
        loader(false);
        show('streams');
    }, function () { loader(false); if (autoFirst) { toast('No hay fuentes para el siguiente episodio'); show('streams'); return; } $('streams-list').innerHTML = 'Error al cargar las fuentes.'; show('streams'); });
}

// Wznów z ekranu głównego: pobierz źródła i ustaw pozycję startową
function resumeItem(r) {
    resumeMs = Number(r.positionMs) || 0;
    playCtx = { contentId: r.contentId, tmdbId: r.tmdbId, type: r.type, season: r.season, episode: r.episode };
    currentMeta = { title: r.title, id: r.tmdbId, type: r.type };
    loadStreams(r.type, r.tmdbId, r.season, r.episode);
}

function fmtSize(b) {
    if (!b) return '';
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    return Math.round(b / 1048576) + ' MB';
}
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function renderStreams() {
    var list = $('streams-list');
    list.innerHTML = '';
    if (!streams.length) { list.innerHTML = '<div style="font-size:30px;color:#9aa3b2">No hay fuentes disponibles.</div>'; return; }
    for (var i = 0; i < streams.length; i++) {
        var s = streams[i];
        var sz = fmtSize(s.size);
        var html = '<div class="srow1">' +
            '<span class="q">' + esc(s.quality || '?') + '</span>' +
            '<span class="pv">' + esc(s.provider || '') + '</span>' +
            (sz ? '<span class="sz">' + esc(sz) + '</span>' : '') + '</div>';
        // pełny opis źródła 1:1 jak w dodatku (język, rozmiar, seedery)
        var desc = s.desc && s.desc !== s.title ? s.desc : (s.title || '');
        if (desc) html += '<div class="desc">' + esc(desc) + '</div>';
        list.appendChild(el('div', 'stream', html));
    }
    setStreamFocus(0);
}

function setStreamFocus(i) {
    clearFocusAll();
    var rows = $('streams-list').childNodes;
    if (i < 0) i = 0; if (i >= rows.length) i = rows.length - 1;
    streamIdx = i;
    if (rows[i] && rows[i].className !== undefined) {
        rows[i].className = 'stream focused';
        keepVisible($('streams-list'), rows[i]);
    }
}

// ---------- Odtwarzacz (AVPlay) ----------
var player = null, playing = false, duration = 0;
var audioTracks = [], textTracks = [], extSubs = [];
var menuOpen = false, menuCol = 0, menuIdx = 0;
var hideTimer = null, subClearTimer = null;

function avplay() { return (window.webapis && window.webapis.avplay) ? window.webapis.avplay : null; }

// --- Modo HTML5 (módulos TizenBrew: sin webapis/AVPlay) ---
var h5video = null;
function h5ensure() {
    if (!h5video) {
        h5video = document.createElement('video');
        h5video.id = 'h5-player';
        h5video.setAttribute('playsinline', '');
        document.body.appendChild(h5video);
    }
    return h5video;
}
function h5Time() { return h5video ? Math.round((h5video.currentTime || 0) * 1000) : 0; }

// Wznowienie: przewiń do zapisanej pozycji dopiero gdy odtwarzacz gra (Tizen 2.3 nie przewija przed play)
function doPendingSeek() {
    if (pendingSeekMs <= 0) return;
    var target = Math.round(pendingSeekMs);
    pendingSeekMs = 0;                 // wyczyść przed przewinięciem, by uniknąć pętli
    if (h5video) { try { h5video.currentTime = target / 1000; } catch (e) {} $('player-status').innerHTML = ''; return; }
    var ap = avplay(); if (!ap) return;
    try { ap.seekTo(target); }
    catch (e) { try { ap.jumpForward(target); } catch (e2) {} }
    $('player-status').innerHTML = '';
}

function fmt(ms) {
    var s = Math.floor(ms / 1000); var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(s);
}

// pokazywanie/ukrywanie kontrolek (pełny ekran)
function showControls() {
    $('view-player').className = 'view' + (liveCtx ? ' live' : '');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (view === 'player' && !menuOpen) $('view-player').className = 'view controls-hidden'; }, 4000);
}
function hideControlsNow() { if (hideTimer) clearTimeout(hideTimer); $('view-player').className = 'view' + (liveCtx ? ' live' : '') + ' controls-hidden'; }

// odczyt ścieżek audio/napisów z pliku
function langName(code) {
    code = String(code || '').toLowerCase();
    var M = { pol: 'Polaco', pl: 'Polaco', eng: 'Inglés', en: 'Inglés', ger: 'Alemán', deu: 'Alemán',
        de: 'Alemán', fre: 'Francés', fra: 'Francés', fr: 'Francés', spa: 'Español', es: 'Español',
        ita: 'Italiano', it: 'Italiano', rus: 'Ruso', ru: 'Ruso', jpn: 'Japonés', ja: 'Japonés',
        pob: 'Portugués (BR)', por: 'Portugués', cze: 'Checo', ukr: 'Ucraniano' };
    return M[code] || (code ? code.toUpperCase() : '');
}
function parseExtra(ei) {
    var o = {}; try { o = JSON.parse(ei); } catch (e) { return {}; }
    return o;
}
// Formatowanie tekstu napisów: <br>, \n, \N, bloki ASS {..}, tagi -> czyste nowe wiersze + kursywa
function fmtSub(text) {
    var t = String(text || '');
    t = t.replace(/\{[^}]*\}/g, '');                 // bloki ASS/SSA {\an8} itd.
    t = t.replace(/\\N/gi, '\n').replace(/\\n/g, '\n'); // twarde/miękkie łamania ASS
    t = t.replace(/<br\s*\/?>/gi, '\n');             // <br>, <br/>
    t = t.replace(/\r/g, '\n');
    t = t.replace(/<\s*\/?\s*font[^>]*>/gi, '');     // tagi font
    // zabezpiecz kursywę/pogrubienie, usuń resztę tagów
    t = t.replace(/<\s*i\s*>/gi, 'I').replace(/<\s*\/\s*i\s*>/gi, '/I');
    t = t.replace(/<\s*b\s*>/gi, 'B').replace(/<\s*\/\s*b\s*>/gi, '/B');
    t = t.replace(/<[^>]*>/g, '');
    t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    t = t.replace(/I/g, '<i>').replace(/\/I/g, '</i>')
         .replace(/B/g, '<b>').replace(/\/B/g, '</b>');
    t = t.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, '');
    t = t.replace(/\n/g, '<br>');
    return t;
}
function readTracks() {
    audioTracks = []; textTracks = [];
    var ap = avplay(); if (!ap || !ap.getTotalTrackInfo) return;
    var info;
    try { info = ap.getTotalTrackInfo(); } catch (e) { return; }
    for (var i = 0; i < info.length; i++) {
        var tr = info[i]; var ex = parseExtra(tr.extra_info);
        var lang = ex.language || ex.lang || ex.track_lang || ex.language_code || '';
        if (tr.type === 'AUDIO') audioTracks.push({ index: tr.index, lang: lang, label: langName(lang) || ('Pista ' + (audioTracks.length + 1)) });
        else if (tr.type === 'TEXT') textTracks.push({ index: tr.index, lang: lang, label: langName(lang) || ('Subtítulos ' + (textTracks.length + 1)) });
    }
}

// napisy zewnętrzne z Twoich addonów (OpenSubtitles)
function loadExtSubs() {
    extSubs = [];
    if (!playCtx || !playCtx.tmdbId) return;
    var url = BRIDGE + '/api/subtitles/' + playCtx.type + '/' + playCtx.tmdbId;
    var q = [];
    if (playCtx.season != null) q.push('season=' + playCtx.season);
    if (playCtx.episode != null) q.push('episode=' + playCtx.episode);
    if (q.length) url += '?' + q.join('&');
    get(url, function (d) {
        extSubs = (d.subtitles || []).slice(0, 20);
        applyPreferredSub();
    }, function () {});
}

function playStream(s, live) {
    var ap = avplay();
    show('player');
    $('subtitle-text').innerHTML = '';
    $('player-live').className = live ? '' : 'hidden';
    $('view-player').className = 'view' + (live ? ' live' : '');
    $('player-info').innerHTML = live
        ? (currentMeta ? currentMeta.title : '') + (s.quality ? '  ·  ' + s.quality : '')
        : (currentMeta ? currentMeta.title : '') + '  —  ' + (s.quality || '');
    $('player-status').innerHTML = 'Cargando vídeo...';
    $('player-fill').style.width = '0%';
    $('upnext').className = 'hidden';
    showControls();
    if (!ap) { return playStreamHtml5(s, live); }
    loadExtSubs();
    try {
        try { ap.stop(); ap.close(); } catch (e0) {}
        ap.open(s.url);
        ap.setDisplayRect(0, 0, 1920, 1080);
        try { ap.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e1) {}
        ap.setListener({
            onbufferingstart: function () { $('player-status').innerHTML = 'Cargando vídeo...'; },
            onbufferingprogress: function (p) { $('player-status').innerHTML = 'Cargando ' + p + '%'; },
            onbufferingcomplete: function () {
                $('player-status').innerHTML = '';
                doPendingSeek();   // gdy bufor gotowy — przewiń do zapisanej pozycji
            },
            oncurrentplaytime: function (t) {
                if (!duration) { try { duration = ap.getDuration(); } catch (e) {} }
                // wznawianie: przewiń raz, gdy odtwarzacz faktycznie gra a jesteśmy na początku
                if (pendingSeekMs > 0 && t < pendingSeekMs - 4000) { doPendingSeek(); return; }
                if (duration > 0) $('player-fill').style.width = (t / duration * 100) + '%';
                $('player-time').innerHTML = fmt(t) + (duration ? ' / ' + fmt(duration) : '');
            },
            onsubtitlechange: function (dur, text) {
                var st = $('subtitle-text'); st.innerHTML = fmtSub(text);
                if (subClearTimer) clearTimeout(subClearTimer);
                var d = Number(dur) || 3000;
                subClearTimer = setTimeout(function () { st.innerHTML = ''; }, d > 0 ? d : 3000);
            },
            onstreamcompleted: function () { endedPlayback(); },
            onerror: function (e) { $('player-status').innerHTML = 'Error de reproducción: ' + (e && e.name ? e.name : e); showControls(); }
        });
        ap.prepareAsync(function () {
            duration = 0;
            try { duration = ap.getDuration(); } catch (e) {}
            // NIE przewijamy przed play() (na Tizen 2.3 nie działa) — ustawiamy do zrobienia gdy gra
            pendingSeekMs = resumeMs > 3000 ? resumeMs : 0;
            ap.play();
            playing = true;
            $('player-status').innerHTML = pendingSeekMs ? 'Reanudando desde ' + fmt(pendingSeekMs) + '...' : '';
            readTracks();
            startProgressSync();
            showControls();
            if (pendingSeekMs) setTimeout(doPendingSeek, 1500); // zapas gdyby zdarzenia nie odpaliły
        }, function (e) { $('player-status').innerHTML = 'No se pudo preparar el stream.'; });
    } catch (ex) {
        $('player-status').innerHTML = 'Error: ' + ex.message;
    }
}

// Reproductor HTML5 (fallback para módulos sin AVPlay)
function playStreamHtml5(s, live) {
    var v = h5ensure();
    h5ClearSubs();
    if (hlsPlayer) { try { hlsPlayer.destroy(); } catch (e) {} hlsPlayer = null; }
    v.style.display = 'block';
    duration = 0; playing = false; pendingSeekMs = resumeMs > 3000 ? resumeMs : 0;
    var useHls = !!(s.hls || /\.m3u8(\?|$)/i.test(s.url || '')) && window.Hls && window.Hls.isSupported();
    if (useHls) {
        try { v.removeAttribute('src'); v.load(); } catch (e0) {}
        hlsPlayer = new window.Hls({ enableWorker: false, maxBufferLength: live ? 20 : 30 });
        hlsPlayer.loadSource(s.url);
        hlsPlayer.attachMedia(v);
        hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, function () { try { v.play(); } catch (e1) {} });
        hlsPlayer.on(window.Hls.Events.ERROR, function (evt, data) {
            if (data && data.fatal) $('player-status').innerHTML = 'No se pudo reproducir el canal.';
        });
    } else if (s.hls) {
        $('player-status').innerHTML = 'Este canal necesita un reproductor HLS no disponible.';
    } else {
        v.src = s.url;
    }
    loadExtSubs();
    v.onloadedmetadata = function () { try { duration = Math.round((v.duration || 0) * 1000); } catch (e) {} };
    v.onwaiting = function () { $('player-status').innerHTML = 'Cargando vídeo...'; };
    v.onplaying = function () { playing = true; $('player-status').innerHTML = ''; };
    v.oncanplay = function () { if (!pendingSeekMs) $('player-status').innerHTML = ''; };
    v.ontimeupdate = function () {
        var t = h5Time();
        h5RenderSubs(t);
        if (pendingSeekMs > 0 && t < pendingSeekMs - 4000) { try { v.currentTime = pendingSeekMs / 1000; pendingSeekMs = 0; } catch (e) {} }
        if (duration > 0) $('player-fill').style.width = (t / duration * 100) + '%';
        $('player-time').innerHTML = fmt(t) + (duration ? ' / ' + fmt(duration) : '');
    };
    v.onended = function () { endedPlayback(); };
    v.onerror = function () { $('player-status').innerHTML = 'No se pudo reproducir (formato no soportado por esta tele).'; showControls(); };
    var pp = v.play();
    if (pp && pp.then) { pp.catch(function () { $('player-status').innerHTML = 'Pulsa OK para reproducir'; }); }
    startProgressSync(); showControls();
}

// ---------- Menu ścieżek: dźwięk + napisy ----------
function openTrackMenu() {
    if (!audioTracks.length) readTracks();
    menuOpen = true; menuCol = 0; menuIdx = 0;
    $('track-menu').className = '';
    $('view-player').className = 'view' + (liveCtx ? ' live' : '');
    if (hideTimer) clearTimeout(hideTimer);
    renderTrackMenu();
}
function closeTrackMenu() { menuOpen = false; $('track-menu').className = 'hidden'; showControls(); }
function subItems() {
    var arr = [{ kind: 'off', label: 'Desactivado' }];
    for (var i = 0; i < textTracks.length; i++) arr.push({ kind: 'embed', label: textTracks[i].label + ' (en archivo)', index: textTracks[i].index });
    for (var j = 0; j < extSubs.length; j++) arr.push({ kind: 'ext', label: (langName(extSubs[j].lang) || extSubs[j].lang) + ' (online)', url: extSubs[j].url });
    return arr;
}
function renderTrackMenu() {
    var aL = $('tm-audio-list'); aL.innerHTML = '';
    for (var i = 0; i < audioTracks.length; i++) {
        var cls = 'tm-item' + (menuCol === 0 && menuIdx === i ? ' focused' : '') + (curAudioIndex === audioTracks[i].index ? ' active' : '');
        aL.appendChild(el('div', cls, esc(audioTracks[i].label)));
    }
    if (!audioTracks.length) aL.appendChild(el('div', 'tm-item', 'Una pista'));
    var sItems = subItems(); var sL = $('tm-subs-list'); sL.innerHTML = '';
    for (var j = 0; j < sItems.length; j++) {
        var act = (curSubKey === sItems[j].kind + (sItems[j].index != null ? sItems[j].index : sItems[j].url || ''));
        var cls2 = 'tm-item' + (menuCol === 1 && menuIdx === j ? ' focused' : '') + (act ? ' active' : '');
        sL.appendChild(el('div', cls2, esc(sItems[j].label)));
    }
    var box = (menuCol === 0) ? aL : sL;
    var foc = box.childNodes[Math.min(menuIdx, box.childNodes.length - 1)];
    keepVisible(box, foc);
}
var curAudioIndex = -1, curSubKey = 'off';
function menuLen(col) { return col === 0 ? Math.max(1, audioTracks.length) : subItems().length; }
function keyMenu(k) {
    if (k === KEY.RETURN || k === KEY.BACK) return closeTrackMenu();
    if (k === KEY.LEFT) { menuCol = 0; menuIdx = Math.min(menuIdx, menuLen(0) - 1); renderTrackMenu(); }
    else if (k === KEY.RIGHT) { menuCol = 1; menuIdx = Math.min(menuIdx, menuLen(1) - 1); renderTrackMenu(); }
    else if (k === KEY.UP) { menuIdx = menuIdx > 0 ? menuIdx - 1 : 0; renderTrackMenu(); }
    else if (k === KEY.DOWN) { menuIdx = menuIdx < menuLen(menuCol) - 1 ? menuIdx + 1 : menuIdx; renderTrackMenu(); }
    else if (k === KEY.ENTER) { menuCol === 0 ? selectAudio(menuIdx) : selectSub(menuIdx); }
}
function selectAudio(i) {
    var t = audioTracks[i]; if (!t) return;
    var ap = avplay();
    try { ap.setSelectTrack('AUDIO', t.index); curAudioIndex = t.index; } catch (e) {}
    renderTrackMenu();
}
function selectSub(i) {
    var it = subItems()[i]; if (!it) return;
    var ap = avplay();
    $('subtitle-text').innerHTML = '';
    if (it.kind === 'off') {
        try { if (ap && ap.setSilentSubtitle) ap.setSilentSubtitle(true); } catch (e) {}
        h5ClearSubs();
        curSubKey = 'off';
    } else if (it.kind === 'embed') {
        try { if (ap) { if (ap.setSilentSubtitle) ap.setSilentSubtitle(false); ap.setSelectTrack('TEXT', it.index); } } catch (e) {}
        curSubKey = 'embed' + it.index;
    } else if (it.kind === 'ext') {
        if (avplay()) applyExternalSub(it.url); else h5LoadSub(it.url);
        curSubKey = 'ext' + it.url;
    }
    renderTrackMenu();
    closeTrackMenu();
}
// pobierz napisy online i wczytaj do AVPlay (zapis do pliku lokalnego)
function applyExternalSub(url) {
    $('player-status').innerHTML = 'Cargando subtítulos...';
    var x = new XMLHttpRequest();
    x.open('GET', url, true); x.timeout = 20000;
    x.onreadystatechange = function () {
        if (x.readyState === 4) {
            $('player-status').innerHTML = '';
            if (x.status >= 200 && x.status < 300 && x.responseText) {
                saveSubFile(x.responseText, function (path) {
                    if (!path) { $('subtitle-text').innerHTML = '(no se pudieron cargar los subtítulos)'; return; }
                    var ap = avplay();
                    try { if (ap.setSilentSubtitle) ap.setSilentSubtitle(false); } catch (e) {}
                    try { ap.setExternalSubtitlePath(path); } catch (e) { $('player-status').innerHTML = 'Subtítulos: ' + e.message; }
                });
            } else { $('subtitle-text').innerHTML = '(error de subtítulos)'; }
        }
    };
    x.onerror = function () { $('player-status').innerHTML = ''; };
    x.send();
}
function saveSubFile(text, cb) {
    try {
        if (!window.tizen || !tizen.filesystem) return cb(null);
        tizen.filesystem.resolve('wgt-private-tmp', function (dir) {
            try {
                var f = dir.createFile('sub_' + Date.now() + '.srt');
                f.openStream('w', function (stream) { stream.write(text); stream.close(); cb(f.fullPath); },
                    function () { cb(null); }, 'UTF-8');
            } catch (e) { cb(null); }
        }, function () { cb(null); }, 'rw');
    } catch (e) { cb(null); }
}

// ---- Subtítulos en modo HTML5 (módulo TizenBrew sin AVPlay): SRT propio ----
var h5subs = [], h5subsShown = -1, h5subUrl = '';
function h5ClearSubs() { h5subs = []; h5subsShown = -1; h5subUrl = ''; $('subtitle-text').innerHTML = ''; }
function srtTimeToMs(t) {
    var m = t.match(/(\d+):(\d+):(\d+)[,.]?(\d+)?/);
    if (!m) return 0;
    return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+(m[4] || 0));
}
function parseSubs(text) {
    var cues = [];
    text = String(text || '').replace(/\r/g, '');
    var blocks = text.split(/\n{2,}/);
    for (var i = 0; i < blocks.length; i++) {
        var lines = blocks[i].split('\n');
        var ti = -1;
        for (var j = 0; j < lines.length; j++) { if (lines[j].indexOf('-->') > -1) { ti = j; break; } }
        if (ti < 0) continue;
        var parts = lines[ti].split('-->');
        var s = srtTimeToMs(parts[0] || ''), e = srtTimeToMs(parts[1] || '');
        if (!s && !e) continue;
        var txt = lines.slice(ti + 1).join('\n');
        if (txt) cues.push({ s: s, e: e || (s + 4000), t: txt });
    }
    return cues;
}
function h5LoadSub(url) {
    if (h5subUrl === url && h5subs.length) return;
    $('player-status').innerHTML = 'Cargando subtítulos...';
    var x = new XMLHttpRequest();
    x.open('GET', url, true); x.timeout = 30000;
    x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        $('player-status').innerHTML = '';
        if (x.status >= 200 && x.status < 300 && x.responseText) {
            h5subs = parseSubs(x.responseText); h5subsShown = -1; h5subUrl = url;
            if (!h5subs.length) $('subtitle-text').innerHTML = '(subtítulo vacío o formato no reconocido)';
        } else {
            $('subtitle-text').innerHTML = '(error al cargar el subtítulo)';
        }
    };
    x.onerror = function () { $('player-status').innerHTML = ''; };
    x.send();
}
function h5RenderSubs(tMs) {
    if (!h5subs.length) return;
    var idx = -1;
    for (var i = 0; i < h5subs.length; i++) {
        if (tMs >= h5subs[i].s - 150 && tMs <= h5subs[i].e + 150) { idx = i; break; }
    }
    if (idx === h5subsShown) return;
    h5subsShown = idx;
    var st = $('subtitle-text');
    st.innerHTML = idx >= 0 ? fmtSub(h5subs[idx].t) : '';
}

// Zapis postępu na konto Nuvio (co 15 s, przy pauzie i zatrzymaniu) — kompatybilny między urządzeniami
function currentPos() { if (h5video) return h5Time(); var ap = avplay(); try { return ap ? ap.getCurrentTime() : 0; } catch (e) { return 0; } }
function saveProgress() {
    if (!playCtx || liveCtx) return;
    var pos = currentPos();
    if (!pos || !duration) return;
    post(BRIDGE + '/me/progress', {
        contentId: playCtx.contentId, tmdbId: playCtx.tmdbId, type: playCtx.type,
        season: playCtx.season, episode: playCtx.episode,
        positionMs: pos, durationMs: duration
    });
}
function startProgressSync() {
    if (progressTimer) clearInterval(progressTimer);
    if (liveCtx) return;
    progressTimer = setInterval(saveProgress, 15000);
    startEndWatch();
}

function stopPlayback(auto) {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (endTimer) { clearInterval(endTimer); endTimer = null; }
    if (!liveCtx) saveProgress();
    hideUpNext();
    if (menuOpen) closeTrackMenu();
    menuOpen = false; $('track-menu').className = 'hidden';
    $('subtitle-text').innerHTML = '';
    var ap = avplay();
    if (ap) { try { ap.stop(); ap.close(); } catch (e) {} }
    if (h5video) { try { h5video.pause(); h5video.removeAttribute('src'); h5video.load(); } catch (e) {} h5video.style.display = 'none'; }
    if (hlsPlayer) { try { hlsPlayer.destroy(); } catch (e) {} hlsPlayer = null; }
    var wasLive = !!liveCtx;
    liveCtx = null; liveList = []; liveIdx = 0;
    $('player-live').className = 'hidden';
    $('view-player').className = 'view hidden';
    playing = false; duration = 0; resumeMs = 0;
    h5ClearSubs();
    if (wasLive) { show('home'); focusHome(); } else show('streams');
}

function togglePause() {
    if (h5video) {
        showControls();
        try {
            if (h5video.paused) { h5video.play(); playing = true; $('player-status').innerHTML = ''; }
            else { h5video.pause(); playing = false; $('player-status').innerHTML = '❚❚ Pausa'; saveProgress(); }
        } catch (e) {}
        return;
    }
    var ap = avplay(); if (!ap) return;
    try {
        if (playing) { ap.pause(); playing = false; $('player-status').innerHTML = '❚❚ Pausa'; showControls(); saveProgress(); }
        else { ap.play(); playing = true; $('player-status').innerHTML = ''; showControls(); }
    } catch (e) {}
}

function seek(deltaMs) {
    showControls();
    if (h5video) {
        try {
            var nt = (h5video.currentTime || 0) + deltaMs / 1000;
            if (nt < 0) nt = 0;
            if (duration > 0 && nt * 1000 > duration - 1000) nt = duration / 1000 - 1;
            h5video.currentTime = nt;
        } catch (e) {}
        return;
    }
    var ap = avplay(); if (!ap) return;
    try {
        if (deltaMs > 0) ap.jumpForward(Math.abs(deltaMs));
        else ap.jumpBackward(Math.abs(deltaMs));
    } catch (e) {}
}

// ---------- Wyszukiwarka ----------
function openSearch() { navFocus = false; renderNav(); searchQuery = ''; searchItems = []; searchIdx = 0; renderSearch(); show('search'); }
function renderSearch() {
    $('search-query').innerHTML = searchQuery;
    $('search-label').style.display = searchQuery ? 'none' : 'inline-block';
    var box = $('search-results'); box.innerHTML = '';
    for (var i = 0; i < searchItems.length; i++) {
        var it = searchItems[i];
        var card = cardForItem(it);
        card.onclick = (function (item) { return function () { openDetail(item); }; })(it);
        box.appendChild(card);
    }
    if (searchItems.length) setSearchFocus(0);
}
function setSearchFocus(i) {
    clearFocusAll();
    var rows = $('search-results').childNodes;
    if (i < 0) i = 0; if (i >= rows.length) i = rows.length - 1;
    searchIdx = i;
    if (rows[i]) { rows[i].className = 'card focused'; $('search-results').style.marginLeft = (-i * 232) + 'px'; }
}
function doSearch() {
    if (!searchQuery) return;
    loader(true, 'Buscando...');
    get(BRIDGE + '/api/search?q=' + encodeURIComponent(searchQuery), function (data) {
        searchItems = data.items || []; loader(false); renderSearch();
    }, function () { loader(false); });
}

// ---------- Obsługa klawiszy ----------
function onKey(e) {
    var k = e.keyCode;
    if (view === 'login') { if (k === KEY.RETURN || k === KEY.BACK) exitApp(); return; }
    if (navFocus) return keyNav(k);
    if (view === 'home') return keyHome(k);
    if (view === 'library') return keyLibrary(k);
    if (view === 'catalog') return keyCatalog(k);
    if (view === 'settings') return keySettings(k);
    if (view === 'collection') return keyCollection(k);
    if (view === 'folder') return keyFolder(k);
    if (view === 'detail') return keyDetail(k);
    if (view === 'streams') return keyStreams(k);
    if (view === 'player') return keyPlayer(k);
    if (view === 'search') return keySearch(k);
}

function keyHome(k) {
    if (k === KEY.RIGHT) setHomeFocus(homeR, homeC + 1);
    else if (k === KEY.LEFT) {
        if (homeC === 0) setNavFocus(0); else setHomeFocus(homeR, homeC - 1);
    }
    else if (k === KEY.DOWN) setHomeFocus(homeR + 1 < homeRows.length ? homeR + 1 : homeR, homeC);
    else if (k === KEY.UP) setHomeFocus(homeR > 0 ? homeR - 1 : 0, homeC);
    else if (k === KEY.ENTER) {
        var it = homeRows[homeR] && homeRows[homeR].items[homeC];
        var def = homeRows[homeR] && homeRows[homeR].def;
        if (!it && def && def.kind === 'catalog' && homeC >= homeRows[homeR].items.length) openCatalog(def);
        else if (it && it.more) openCatalog(it.more);
        else if (it && it.folder && def && def.collectionId) openFolder(def.collectionId, it);
        else if (it && it.resume) resumeItem(it.resume);
        else if (it && isChannelType(it.type)) startLive(it, homeRows[homeR].items, homeC);
        else if (it && it.type === 'collection') openAioCollection(it);
        else if (it) openDetail(it);
    }
    else if (k === KEY.RETURN || k === KEY.BACK) exitApp();
}

function keyDetail(k) {
    if (k === KEY.BLUE) {
        var f = detailFocus[detailIdx];
        if (f && f.ep) {
            var on = toggleWatched(f.ep, null);
            if (on) { f.el.className = 'ep watched focused'; if (!f.el.querySelector('.wcheck')) f.el.appendChild(el('span', 'wcheck', '\u2713 Visto')); }
            else { f.el.className = 'ep focused'; var wc = f.el.querySelector('.wcheck'); if (wc) f.el.removeChild(wc); }
        }
        return;
    }
    if (k === KEY.DOWN) focusDetail(detailIdx + 1);
    else if (k === KEY.UP) focusDetail(detailIdx - 1);
    else if (k === KEY.RIGHT) focusDetail(detailIdx + 1);
    else if (k === KEY.LEFT) focusDetail(detailIdx - 1);
    else if (k === KEY.ENTER) { if (detailFocus[detailIdx]) detailFocus[detailIdx].action(); }
    else if (k === KEY.RETURN || k === KEY.BACK) {
        var f = detailFrom || 'home';
        show(f);
        if (f === 'folder') { folderArea = 'grid'; focusGrid(gridIdx); }
        else if (f === 'collection') focusCollection(collIdx);
        else if (f === 'home') focusHome();
        else if (f === 'library') { libLoad(); renderLibrary(); if (libItems.length) setLibraryFocus(Math.min(libIdx, libItems.length - 1)); }
        else if (f === 'catalog') { show('catalog'); setCatalogFocus(catIdx); }
        else if (f === 'search') setSearchFocus(searchIdx);
    }
}

function keyStreams(k) {
    if (k === KEY.DOWN) setStreamFocus(streamIdx + 1);
    else if (k === KEY.UP) setStreamFocus(streamIdx - 1);
    else if (k === KEY.ENTER) { if (streams[streamIdx]) playStream(streams[streamIdx]); }
    else if (k === KEY.RETURN || k === KEY.BACK) show('detail');
}

function keyPlayer(k) {
    if (menuOpen) return keyMenu(k);
    if (upNextData) {
        if (k === KEY.ENTER) return playUpNext();
        if (k === KEY.RETURN || k === KEY.BACK) { hideUpNext(); stopPlayback(true); return; }
    }
    if (liveCtx) {
        if (k === KEY.UP) return zapChannel(1);
        if (k === KEY.DOWN) return zapChannel(-1);
        if (k === KEY.RETURN || k === KEY.BACK || k === KEY.STOP) return stopPlayback();
        if (k === KEY.GREEN || k === KEY.YELLOW || k === KEY.INFO) return openTrackMenu();
        if (k === KEY.ENTER || k === KEY.PLAYPAUSE || k === KEY.PLAY || k === KEY.PAUSE) return showControls();
        return;
    }
    if (k === KEY.RETURN || k === KEY.BACK || k === KEY.STOP) stopPlayback();
    else if (k === KEY.UP || k === KEY.YELLOW || k === KEY.GREEN) openTrackMenu();
    else if (k === KEY.ENTER || k === KEY.PLAYPAUSE || k === KEY.PLAY || k === KEY.PAUSE) togglePause();
    else if (k === KEY.RIGHT || k === KEY.FF) seek(30000);
    else if (k === KEY.LEFT || k === KEY.RW) seek(-15000);
    else if (k === KEY.DOWN) showControls();
}

function keySearch(k) {
    if (k >= 48 && k <= 57) { searchQuery += String.fromCharCode(k); renderSearch(); }
    else if (k >= 65 && k <= 90) { searchQuery += String.fromCharCode(k + 32); renderSearch(); }
    else if (k === 8 || k === 65376) { searchQuery = searchQuery.slice(0, -1); renderSearch(); }
    else if (k === KEY.ENTER) {
        if ($('search-results').childNodes.length && document.querySelector('#search-results .focused')) {
            if (searchItems[searchIdx]) return openDetail(searchItems[searchIdx]);
        }
        doSearch();
    }
    else if (k === KEY.RIGHT) setSearchFocus(searchIdx + 1);
    else if (k === KEY.LEFT) setSearchFocus(searchIdx - 1);
    else if (k === 32) { searchQuery += ' '; renderSearch(); }
    else if (k === KEY.RETURN || k === KEY.BACK) show('home');
}

function exitApp() {
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { /* przeglądarka */ }
}

// ---------- Zegar ----------
function tickClock() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    $('clock').innerHTML = p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---------- Start ----------
function registerKeys() {
    if (window.tizen && tizen.tvinputdevice) {
        var keys = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop',
            'MediaFastForward', 'MediaRewind', 'ColorF0Red', 'ColorF1Green',
            'ColorF2Yellow', 'ColorF3Blue', 'Info'];
        for (var i = 0; i < keys.length; i++) { try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) {} }
    }
}

// Dopasuj warstwę UI do realnego rozmiaru ekranu (viewport bywa 1280 lub 1920)
// SAFE < 1 = margines na overscan starych TV (panel obcina brzegi). Interfejs wyśrodkowany.
var SAFE = 0.985;
function fitScreen() {
    var w = window.innerWidth || document.documentElement.clientWidth || 1920;
    var h = window.innerHeight || document.documentElement.clientHeight || 1080;
    var s = Math.min(w / 1920, h / 1080) * SAFE;
    var tx = Math.round((w - 1920 * s) / 2), ty = Math.round((h - 1080 * s) / 2);
    var appEl = $('app');
    SCALE = s;
    var tr = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    appEl.style.webkitTransform = tr;
    appEl.style.transform = tr;
}

function init() {
    fitScreen();
    window.addEventListener('resize', fitScreen);
    registerKeys();
    document.addEventListener('keydown', onKey);
    tickClock(); setInterval(tickClock, 15000);
    loadSettings(); libLoad(); renderNav();
    loadWatched(function () {
        if (view === 'home') {
            for (var i = 0; i < homeRows.length; i++) renderRow(i);
            setHomeFocus(homeR, homeC);
        }
    });
    show('login');
    $('login-status').innerHTML = 'Conectando con tu cuenta...';
    get(BRIDGE + '/me/status', function (s) {
        if (s.loggedIn) enterApp();
        else startLogin();
    }, function () { $('login-status').innerHTML = 'Sin conexión con el servidor (revisa BRIDGE_URL en js/config.js). Reintentando...'; setTimeout(init, 4000); });
}

window.onload = init;
})();
