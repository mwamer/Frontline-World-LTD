// ---- Mobile menu ----
function toggleMenu(event) {
    const navLinks = document.querySelector('.nav-links');
    if (!navLinks) return;
    const isOpen = navLinks.classList.toggle('active');
    const toggleButton = event ? event.currentTarget : document.querySelector('.nav-toggle');
    if (toggleButton && toggleButton.hasAttribute('aria-expanded')) {
        toggleButton.setAttribute('aria-expanded', String(isOpen));
    }
}

document.querySelector('.nav-toggle').addEventListener('click', toggleMenu);

function closeMenu() {
    const navLinks = document.querySelector('.nav-links');
    const toggleButton = document.querySelector('.nav-toggle');
    navLinks.classList.remove('active');
    if (toggleButton) {
        toggleButton.setAttribute('aria-expanded', 'false');
    }
}

// Close menu when a link is clicked
document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', closeMenu);
});

// Close menu on Escape key or when clicking outside the nav
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeMenu();
    }
});

document.addEventListener('click', (e) => {
    const nav = document.querySelector('.navbar');
    if (nav && !nav.contains(e.target)) {
        closeMenu();
    }
});

// ---- Solidify the transparent header once the page scrolls ----
function updateHeaderOnScroll() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 10);
}

updateHeaderOnScroll();
window.addEventListener('scroll', updateHeaderOnScroll, { passive: true });

// ---- Scroll reveal ----
function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    // Stagger siblings that share the same parent grid
    items.forEach(item => {
        const siblings = item.parentElement
            ? item.parentElement.querySelectorAll('.reveal')
            : null;
        if (siblings && siblings.length > 1) {
            const index = Array.prototype.indexOf.call(siblings, item);
            item.style.transitionDelay = `${(index % 6) * 90}ms`;
        }
    });

    if (!('IntersectionObserver' in window)) {
        items.forEach(item => item.classList.add('is-visible'));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    items.forEach(item => observer.observe(item));
}

initReveal();

// ---- Respect reduced-motion preference for JS-driven scrolling ----
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToElement(element) {
    element.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const targetId = this.getAttribute('href');
        const target = document.querySelector(targetId);
        if (target) {
            e.preventDefault();
            scrollToElement(target);
        }
    });
});

// ---- Homepage video frame ----
function initIntroVideo() {
    const media = document.querySelector('.intro-video__media');
    if (!media) return;
    const video = media.querySelector('video');
    const playButton = media.querySelector('.intro-video__play');
    if (!video || !playButton) return;

    playButton.addEventListener('click', () => {
        const attempt = video.play();
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
    });

    // Hand the frame over to the native controls once the film is running
    video.addEventListener('play', () => {
        media.classList.add('is-playing');
        playButton.setAttribute('aria-hidden', 'true');
        playButton.tabIndex = -1;
    });
    video.addEventListener('ended', () => media.classList.remove('is-playing'));
}

initIntroVideo();

// ---- Associate directory (Our People) ----
// Progressive enhancement: the filter set is generated but ships hidden, so the
// grid works without this script. A card carries the vocabulary ids of its
// expertise, roles, sectors and regions as data attributes, and the search
// haystack the directory built for it. Chips inside one group are alternatives;
// the groups narrow between themselves.
function initAssociateDirectory() {
    const root = document.querySelector('.associate-directory');
    if (!root) return;

    const cards = Array.from(root.querySelectorAll('.associate-card'));
    const filters = root.querySelector('.associate-filters');
    if (!cards.length) return;
    if (filters) filters.hidden = false;

    const chips = Array.from(root.querySelectorAll('.associate-chip'));
    const search = root.querySelector('.associate-search__input');
    const status = root.querySelector('.associate-status');
    const empty = root.querySelector('.associate-empty');
    const active = new Map();

    const hasId = (card, group, id) => (card.dataset[group] || '').split(' ').includes(id);

    function apply() {
        const term = (search ? search.value : '').trim().toLowerCase();
        let shown = 0;

        cards.forEach(card => {
            const matchesGroups = Array.from(active).every(([group, ids]) =>
                Array.from(ids).some(id => hasId(card, group, id)));
            const matchesSearch = !term || (card.dataset.search || '').indexOf(term) !== -1;
            card.hidden = !(matchesGroups && matchesSearch);
            if (!card.hidden) shown += 1;
        });

        if (empty) empty.hidden = shown !== 0;
        if (status) {
            const filtering = active.size > 0 || term !== '';
            status.hidden = !filtering;
            status.textContent = 'Showing ' + shown + ' of ' + cards.length +
                (cards.length === 1 ? ' associate' : ' associates');
        }
    }

    chips.forEach(chip => {
        chip.addEventListener('click', () => {
            const group = chip.dataset.filterGroup;
            const id = chip.dataset.filterValue;
            const ids = active.get(group) || new Set();
            const pressed = ids.has(id);

            if (pressed) ids.delete(id); else ids.add(id);
            if (ids.size) active.set(group, ids); else active.delete(group);
            chip.setAttribute('aria-pressed', String(!pressed));
            apply();
        });
    });

    if (search) search.addEventListener('input', apply);
    apply();
}

initAssociateDirectory();

// ---- Associate application form ----
// The form posts to the applications Worker as multipart/form-data, files
// included. Before this there was no backend: submitting composed an email,
// which could not carry a CV or a photograph at all, so a photograph required
// on the form could never reach us. The address is no longer part of this.
//
// The browser can still do it without this script, because the form's own
// action points at the same endpoint; this only replaces the round trip with a
// page that does not change. There is no email fallback: a submission that does
// not reach the Worker has not been received, and saying otherwise would be a
// lie the applicant acts on.
function initAssociateApplication() {
    const form = document.querySelector('#associate-application');
    if (!form) return;

    const status = document.querySelector('#af-status');
    const submit = form.querySelector('.af-submit');
    const endpoint = form.getAttribute('data-endpoint') || form.getAttribute('action');
    const notes = form.querySelectorAll('.af-hint');
    let sending = false;

    // Check the file sizes here so an applicant waiting on a slow connection is
    // told at once. The Worker checks them again: this is a convenience, not
    // the check that matters.
    form.querySelectorAll('input[type="file"]').forEach((input) => {
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            setNote(input, file ? fileTooBig(file, input) : '');
        });
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (sending) return;
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }

        const oversized = Array.from(form.querySelectorAll('input[type="file"]'))
            .filter((input) => input.files && input.files[0] && fileTooBig(input.files[0], input));
        if (oversized.length) {
            setState(form, status, 'error',
                'One of the files is too large. Please check the file sizes and try again.');
            oversized[0].focus();
            return;
        }

        sending = true;
        if (submit) submit.disabled = true;
        setState(form, status, 'sending', 'Sending your application, including your photograph and CV. Please keep this page open.');

        let response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                body: new FormData(form),
                credentials: 'omit',
                referrerPolicy: 'strict-origin-when-cross-origin',
            });
        } catch (error) {
            sending = false;
            if (submit) submit.disabled = false;
            // No email fallback on purpose. Nothing was sent, so the applicant
            // has to be told to try again rather than left thinking it went.
            setState(form, status, 'error',
                'Your application could not be sent. Please check your connection and try again. Nothing has been received yet, and your answers are still here.');
            return;
        }

        let payload = {};
        try {
            payload = await response.json();
        } catch (error) {
            payload = {};
        }

        if (response.ok && payload.ok) {
            setState(form, status, 'success', payload.message ||
                'Application submitted successfully. Your application has been received and will be reviewed.');
            form.reset();
            clearNotes(notes);
            return;
        }

        sending = false;
        if (submit) submit.disabled = false;
        setState(form, status, 'error', messageFor(response.status, payload));
        highlight(form, payload.fields);
    });
}

function messageFor(status, payload) {
    if (status === 429) return payload.error || 'Too many applications have been sent from this connection. Please try again later.';
    if (status === 413) return payload.error || 'That upload is too large to send. Please reduce the file sizes and try again.';
    if (status === 403) return 'This page could not send your application. Please reload the page and try again.';
    if (status === 422 || status === 400) return payload.error || 'Please check the answers below and try again.';
    return 'Something went wrong on our side and your application was not received. Please try again in a few minutes.';
}

function fileTooBig(file, input) {
    const max = input.getAttribute('data-max-mb');
    if (!max) return false;
    return file.size > Number(max) * 1024 * 1024;
}

function setNote(input, text) {
    const field = input.closest('.af-field');
    let note = field && field.querySelector('.af-note');
    if (!text) {
        if (note) note.remove();
        return;
    }
    if (!note) {
        note = document.createElement('span');
        note.className = 'af-note';
        field.appendChild(note);
    }
    note.textContent = text;
}

function clearNotes(notes) {
    Array.from(notes).forEach((note) => { note.style.display = ''; });
}

function setState(form, status, state, message) {
    form.setAttribute('data-state', state);
    if (status) {
        status.textContent = message;
        status.className = 'af-status af-status--' + state;
    }
    if (state === 'success') {
        form.querySelectorAll('fieldset, .af-actions').forEach((node) => { node.hidden = true; });
    }
}

function highlight(form, fields) {
    form.querySelectorAll('.af-field-error').forEach((node) => node.remove());
    if (!fields || !fields.length) return;
    for (const problem of fields) {
        const input = form.querySelector('[name="' + cssEscape(problem.field) + '"]');
        if (!input) continue;
        const field = input.closest('.af-field') || input.closest('fieldset');
        if (!field) continue;
        const note = document.createElement('span');
        note.className = 'af-note af-field-error';
        note.textContent = problem.message;
        field.appendChild(note);
        input.setAttribute('aria-invalid', 'true');
    }
}

function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

initAssociateApplication();
