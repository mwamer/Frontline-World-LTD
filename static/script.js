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
