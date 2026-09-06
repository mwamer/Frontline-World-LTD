// Toggle mobile menu
function toggleMenu(event) {
    const navLinks = document.querySelector('.nav-links');
    const isOpen = navLinks.classList.toggle('active');
    const toggleButton = event ? event.currentTarget : document.querySelector('.nav-toggle');
    if (toggleButton && toggleButton.hasAttribute('aria-expanded')) {
        toggleButton.setAttribute('aria-expanded', String(isOpen));
    }
}

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

// On mobile, start the expertise accordion collapsed (except the first item)
function initExpertiseAccordion() {
    const items = document.querySelectorAll('.expertise-item');
    if (!items.length || window.innerWidth >= 768) return;
    items.forEach((item, index) => {
        item.open = index === 0;
    });
}

initExpertiseAccordion();

// Solidify the transparent navbar once the page scrolls past the top
function updateNavbarOnScroll() {
    const navbar = document.querySelector('.navbar');
    if (!navbar) return;
    navbar.classList.toggle('scrolled', window.scrollY > 10);
}

updateNavbarOnScroll();
window.addEventListener('scroll', updateNavbarOnScroll, { passive: true });

// Respect the user's reduced-motion preference for JS-driven scrolling
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollToElement(element) {
    element.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function setFieldError(input, message) {
    if (!input) return;
    const errorId = `${input.id}-error`;
    let errorEl = document.getElementById(errorId);
    if (message) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', errorId);
        if (!errorEl) {
            errorEl = document.createElement('p');
            errorEl.id = errorId;
            errorEl.className = 'field-error';
            errorEl.setAttribute('role', 'alert');
            input.insertAdjacentElement('afterend', errorEl);
        }
        errorEl.textContent = message;
    } else {
        input.removeAttribute('aria-invalid');
        if (errorEl) {
            errorEl.remove();
        }
    }
}

// Handle contact form submission
function handleContactForm(event) {
    event.preventDefault();

    const form = event.target;

    // Get values by element id/name if available, falling back to form elements
    const fullNameInput = form.querySelector('#fullName') || form.elements['fullName'] || form.elements[0];
    const organisationInput = form.querySelector('#organisation') || form.elements['organisation'];
    const emailInput = form.querySelector('#email') || form.elements['email'] || form.elements[1];
    const messageInput = form.querySelector('#message') || form.elements['message'] || form.elements[3];

    const fullName = fullNameInput ? fullNameInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';
    const message = messageInput ? messageInput.value.trim() : '';
    const organisation = organisationInput ? organisationInput.value.trim() : '';

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    let firstInvalid = null;

    setFieldError(fullNameInput, fullName ? '' : 'Please enter your full name.');
    if (!fullName) firstInvalid = firstInvalid || fullNameInput;

    if (organisationInput) {
        setFieldError(organisationInput, organisation ? '' : 'Please enter your organisation.');
        if (!organisation) firstInvalid = firstInvalid || organisationInput;
    }

    if (!email) {
        setFieldError(emailInput, 'Please enter your email address.');
        firstInvalid = firstInvalid || emailInput;
    } else if (!emailRegex.test(email)) {
        setFieldError(emailInput, 'Please enter a valid email address.');
        firstInvalid = firstInvalid || emailInput;
    } else {
        setFieldError(emailInput, '');
    }

    setFieldError(messageInput, message ? '' : 'Please describe your enquiry.');
    if (!message) firstInvalid = firstInvalid || messageInput;

    if (firstInvalid) {
        firstInvalid.focus();
        return;
    }

    // Show success message
    alert('Thank you for your enquiry! Frontline World will review your details and get back to you shortly.');
    form.reset();
}

// Helper function to select an Area of Interest checkbox and scroll to form
function selectAreaOfInterest(value) {
    const checkboxes = document.querySelectorAll('input[name="interest"]');
    checkboxes.forEach(cb => {
        if (cb.value === value) {
            cb.checked = true;
        }
    });
    focusContactForm();
}

// Helper function to select Preferred Next Step checkbox and scroll to form
function selectPreferredNextStep(value) {
    const checkboxes = document.querySelectorAll('input[name="nextStep"]');
    checkboxes.forEach(cb => {
        if (cb.value === value) {
            cb.checked = true;
        }
    });
    focusContactForm();
}

// Helper function to scroll to and focus form
function focusContactForm() {
    const section = document.getElementById('contact-form-section');
    if (section) {
        scrollToElement(section);
    }
    const firstInput = document.getElementById('fullName');
    if (firstInput) {
        setTimeout(() => firstInput.focus(), prefersReducedMotion() ? 0 : 400);
    }
}

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const targetId = this.getAttribute('href');
        const target = document.querySelector(targetId);
        if (target) {
            e.preventDefault();
            if (target.classList.contains('expertise-item')) {
                target.open = true;
            }
            scrollToElement(target);
        }
    });
});

// Add active class to current page in navigation
window.addEventListener('load', () => {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-links a').forEach(link => {
        const href = link.getAttribute('href').split('/').pop() || 'index.html';
        if (href === currentPage) {
            link.classList.add('active');
        }
    });
});