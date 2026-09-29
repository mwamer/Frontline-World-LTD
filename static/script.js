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
// The site is static, so the form has nothing to post to. Submitting therefore
// composes an email from the answers and hands it to the visitor's own email
// app, which is where the review already happens. Without scripting the form
// falls back to its own mailto action, so the journey still works.
function initAssociateApplication() {
    const form = document.querySelector('#associate-application');
    if (!form) return;
    const status = document.querySelector('#af-status');
    const submit = form.querySelector('.af-submit');
    // The form's own action is the single place the address is written.
    const recipient = (form.getAttribute('action') || '').replace(/^mailto:/, '').split('?')[0];

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!form.checkValidity()) {
            form.reportValidity();
            return;
        }
        const data = new FormData(form);
        const subject = 'Associate application — ' + (data.get('name') || 'New applicant');
        const body = buildApplicationEmail(data);
        window.location.href = 'mailto:' + recipient + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
        if (status) {
            status.textContent = hasFileToAttach(data)
                ? 'Your email app is opening. Attach your photograph and CV by hand before sending.'
                : 'Your email app is opening with the application ready to send.';
        }
        if (submit) submit.disabled = true;
        setTimeout(() => { if (submit) submit.disabled = false; }, 4000);
    });
}

// An email carries text only, so the photograph and CV have to be added by
// hand. The applicant needs saying so before they send, not after.
function hasFileToAttach(data) {
    return ['photo', 'cv'].some((key) => {
        const value = data.get(key);
        return value instanceof File && value.name;
    });
}

function buildApplicationEmail(data) {
    const lines = [
        'World Frontline World — associate application',
        'Sent: ' + new Date().toISOString().slice(0, 10),
        '',
        'A photograph and a CV cannot travel with an email, so attach any file',
        'named below by hand. Options given as codes are the vocabulary IDs used',
        'in the CMS, so they can be pasted across as they are.',
        ''
    ];
    for (const [heading, fields] of APPLICATION_SECTIONS) {
        const rows = fields
            .map(([key, label]) => [label, readFieldValue(data, key)])
            .filter(([, value]) => value);
        if (!rows.length) continue;
        lines.push(heading.toUpperCase(), '');
        for (const [label, value] of rows) lines.push(label + ': ' + value);
        lines.push('');
    }
    return lines.join('\n');
}

function readFieldValue(data, key) {
    return data.getAll(key)
        // An unticked checkbox contributes nothing, so a value of "on" is a
        // ticked one and reads better as Yes in an email.
        .map((value) => (value instanceof File ? value.name : String(value).trim() === 'on' ? 'Yes' : String(value).trim()))
        .filter(Boolean)
        .join(', ');
}

// The fields of each section, in the order the form asks for them. The names
// match the Applications collection in static/admin/config.yml, so an email
// can be transcribed into a record without renaming anything.
const APPLICATION_SECTIONS = [
    ['Section 1 — Basic information', [
        ['name', 'Full name'],
        ['title', 'Professional title'],
        ['organisation', 'Organisation / affiliation'],
        ['current_role', 'Current position / role'],
        ['email', 'Professional email'],
        ['country', 'Country / base'],
        ['website', 'Website'],
        ['linkedin', 'LinkedIn'],
        ['photo', 'Photograph']
    ]],
    ['Section 2 — Professional profile', [
        ['bio_short', 'Short biography'],
        ['bio_long', 'Extended biography'],
        ['qualifications', 'Qualifications'],
        ['experience', 'Selected experience']
    ]],
    ['Section 3 — Expertise', [
        ['expertise', 'Expertise'],
        ['sectors', 'Sector expertise'],
        ['regions', 'Regional / geographic expertise'],
        ['countries', 'Countries / regions of specific expertise'],
        ['other_expertise', 'Other expertise']
    ]],
    ['Section 4 — Roles and contributions', [
        ['roles', 'Roles'],
        ['contributions', 'Areas of contribution']
    ]],
    ['Section 5 — Teaching and training', [
        ['teaching_subjects', 'Subjects you could teach or deliver'],
        ['delivery', 'Preferred delivery'],
        ['preferred_audiences', 'Preferred audiences'],
        ['languages', 'Languages and proficiency']
    ]],
    ['Section 6 — Availability', [
        ['availability', 'Availability'],
        ['constraints', 'Location or delivery constraints']
    ]],
    ['Section 7 — Supporting information', [
        ['cv', 'CV'],
        ['portfolio_links', 'Publications / portfolio / links'],
        ['additional', 'Additional information']
    ]],
    ['Section 8 — Consent', [
        ['consent_accuracy', 'Information accurate and up to date'],
        ['consent_submission', 'Submission does not guarantee acceptance'],
        ['consent_review', 'Consent to review for association and related work'],
        ['public_consent', 'Consent to publish the profile if approved']
    ]]
];

initAssociateApplication();
