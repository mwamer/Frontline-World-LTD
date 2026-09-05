// Toggle mobile menu
function toggleMenu() {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.toggle('active');
}

// Dropdown menu toggle for mobile
document.querySelectorAll('.dropdown-toggle').forEach(toggle => {
    toggle.addEventListener('click', function(e) {
        if (window.innerWidth <= 768) {
            e.preventDefault();
            const parent = this.parentElement;
            if (parent) {
                const isOpen = parent.classList.contains('open');
                document.querySelectorAll('.nav-links .dropdown').forEach(d => d.classList.remove('open'));
                if (!isOpen) {
                    parent.classList.add('open');
                }
            }
        }
    });
});

// Close menu when a link inside dropdown-menu or non-dropdown nav link is clicked
document.querySelectorAll('.dropdown-menu a, .nav-links > li > a:not(.dropdown-toggle)').forEach(link => {
    link.addEventListener('click', () => {
        const navLinks = document.querySelector('.nav-links');
        if (navLinks) {
            navLinks.classList.remove('active');
        }
        document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
    });
});

// Handle contact form submission
function handleContactForm(event) {
    event.preventDefault();
    
    // Get form values
    const form = event.target;
    const name = form.elements[0].value;
    const email = form.elements[1].value;
    const subject = form.elements[2].value;
    const message = form.elements[3].value;
    
    // Simple validation
    if (!name || !email || !subject || !message) {
        alert('Please fill in all fields');
        return;
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        alert('Please enter a valid email address');
        return;
    }
    
    // Show success message
    alert('Thank you for your message! We will get back to you soon.');
    form.reset();
}

// Smooth scroll for anchor links on current page
document.querySelectorAll('a[href*="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        const href = this.getAttribute('href');
        if (!href) return;
        
        const parts = href.split('#');
        const pagePath = parts[0];
        const targetId = parts[1];
        
        if (!targetId) return;
        
        const currentPage = window.location.pathname.split('/').pop() || 'index.html';
        const isCurrentPage = !pagePath || pagePath === currentPage || pagePath === '' || (currentPage === '' && pagePath === 'index.html');
        
        if (isCurrentPage) {
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({ behavior: 'smooth' });
                if (history.pushState) {
                    history.pushState(null, null, '#' + targetId);
                }
                const navLinks = document.querySelector('.nav-links');
                if (navLinks) navLinks.classList.remove('active');
                document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
            }
        }
    });
});

// Highlight active link in navigation based on current page and hash
window.addEventListener('load', () => {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const currentHash = window.location.hash;
    
    document.querySelectorAll('.nav-links a').forEach(link => {
        const rawHref = link.getAttribute('href') || '';
        link.classList.remove('active');
        
        const hrefPage = rawHref.split('#')[0] || 'index.html';
        const hrefHash = rawHref.includes('#') ? '#' + rawHref.split('#')[1] : '';
        
        if (!currentHash && hrefPage === currentPage && !hrefHash) {
            link.classList.add('active');
        } else if (currentHash && hrefHash && hrefHash === currentHash && (hrefPage === currentPage || !hrefPage)) {
            link.classList.add('active');
        }
    });
});