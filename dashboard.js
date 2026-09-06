const panelTitles = {
    overview: ['Dashboard', 'Manage and monitor your website.'],
    enquiries: ['Enquiries', 'Review incoming contact requests.'],
    pages: ['Website Pages', 'Edit shared text content used by the public website.'],
    services: ['Core Expertise', 'Review the service areas presented on the public site.'],
    news: ['News & Insights', 'Create and manage insight posts.'],
    publications: ['Publications', 'Research reports and publications.'],
    team: ['Team', 'Manage professional profiles.'],
    media: ['Media Library', 'Manage images and visual assets.'],
    settings: ['Settings', 'Your account and access level.']
};


/* =========================================================
   HELPERS
   ========================================================= */

function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (character) {
        const characters = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };

        return characters[character];
    });
}


function formatDate(dateValue) {
    if (!dateValue) {
        return '-';
    }

    return new Date(dateValue).toLocaleDateString(
        undefined,
        {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        }
    );
}


function todayAsInputValue() {
    const now = new Date();

    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    return year + '-' + month + '-' + day;
}


function createSlug(title) {
    const base = title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    return base + '-' + Date.now();
}


function showPanel(name) {
    document
        .querySelectorAll('[data-panel-content]')
        .forEach(function (panel) {
            panel.classList.toggle(
                'active',
                panel.dataset.panelContent === name
            );
        });

    document
        .querySelectorAll('[data-panel]')
        .forEach(function (button) {
            button.classList.toggle(
                'active',
                button.dataset.panel === name
            );
        });

    const panelInfo =
        panelTitles[name] || panelTitles.overview;

    document.getElementById('panel-title').textContent =
        panelInfo[0];

    document.getElementById('panel-description').textContent =
        panelInfo[1];
}


/* =========================================================
   IMAGE UPLOAD
   ========================================================= */

async function uploadImages(files) {
    const uploadedUrls = [];

    if (!files || !files.length) {
        return uploadedUrls;
    }

    for (let i = 0; i < files.length; i++) {
        const file = files[i];

        const extension =
            file.name.includes('.')
                ? file.name.split('.').pop().toLowerCase()
                : 'jpg';

        const safeName =
            file.name
                .replace(/\.[^/.]+$/, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/(^-|-$)/g, '');

        const fileName =
            Date.now() +
            '-' +
            i +
            '-' +
            safeName +
            '.' +
            extension;

        const filePath =
            'insights/' + fileName;

        const uploadResult =
            await client.storage
                .from('media')
                .upload(
                    filePath,
                    file,
                    {
                        cacheControl: '3600',
                        upsert: false
                    }
                );

        if (uploadResult.error) {
            throw uploadResult.error;
        }

        const publicResult =
            client.storage
                .from('media')
                .getPublicUrl(filePath);

        uploadedUrls.push(
            publicResult.data.publicUrl
        );
    }

    return uploadedUrls;
}


/* =========================================================
   IMAGE PREVIEW
   ========================================================= */

function renderImagePreview(urls) {
    const preview =
        document.getElementById('image-preview');

    if (!preview) {
        return;
    }

    if (!urls || !urls.length) {
        preview.innerHTML =
            '<p class="form-help">No images selected.</p>';

        return;
    }

    preview.innerHTML =
        urls.map(function (url, index) {
            return (
                '<div class="preview-image">' +

                '<img src="' +
                escapeHtml(url) +
                '" alt="Insight image ' +
                (index + 1) +
                '">' +

                '<span>' +
                (
                    index === 0
                        ? 'Featured'
                        : 'Image ' + (index + 1)
                ) +
                '</span>' +

                '</div>'
            );
        }).join('');
}


/* =========================================================
   LOAD DASHBOARD
   ========================================================= */

async function loadDashboard(user) {

    document.getElementById('user-name').textContent =
        user.profile.full_name ||
        user.session.user.email;

    document.getElementById('user-role').textContent =
        user.profile.role || '';

    document.getElementById('settings-email').textContent =
        user.session.user.email;


    const results = await Promise.all([

        client
            .from('insights_posts')
            .select(
                'id, title, slug, excerpt, body, category, status, author_id, publication_date, featured_image_url, image_urls, created_at, published_at, updated_at'
            )
            .order(
                'publication_date',
                {
                    ascending: false,
                    nullsFirst: false
                }
            ),

        client
            .from('enquiries')
            .select(
                'id, full_name, organisation, email, status, created_at'
            )
            .order(
                'created_at',
                {
                    ascending: false
                }
            ),

        client
            .from('team_members')
            .select(
                'id, name, role_title, category, sort_order'
            )
            .order('sort_order'),

        client
            .from('content_blocks')
            .select(
                'key, value, updated_at'
            )
            .order('key')
    ]);


    const postsResult = results[0];
    const enquiriesResult = results[1];
    const teamResult = results[2];
    const contentResult = results[3];


    const firstError = [
        postsResult,
        enquiriesResult,
        teamResult,
        contentResult
    ].find(function (result) {
        return result.error;
    });


    if (firstError) {
        throw firstError.error;
    }


    const posts =
        postsResult.data || [];

    const enquiries =
        enquiriesResult.data || [];

    const team =
        teamResult.data || [];

    const content =
        contentResult.data || [];


    const publishedPosts =
        posts.filter(function (post) {
            return post.status === 'published';
        });


    const openEnquiries =
        enquiries.filter(function (enquiry) {
            return enquiry.status !== 'resolved';
        });


    document.getElementById('stat-news').textContent =
        publishedPosts.length;

    document.getElementById('stat-enquiries').textContent =
        openEnquiries.length;

    document.getElementById('stat-team').textContent =
        team.length;

    document.getElementById('stat-content').textContent =
        content.length;


    renderRecentNews(posts);

    renderNewsList(posts);

    renderEnquiries(enquiries);

    renderTeam(team);

    renderContent(content);
}


/* =========================================================
   RECENT INSIGHTS
   ========================================================= */

function renderRecentNews(posts) {

    const element =
        document.getElementById('recent-news');


    if (!posts.length) {

        element.innerHTML =
            '<div class="empty-state">' +
            'No insight posts yet.' +
            '</div>';

        return;
    }


    element.innerHTML =
        '<div class="table-wrap">' +

        '<table>' +

        '<thead>' +
        '<tr>' +
        '<th>Title</th>' +
        '<th>Status</th>' +
        '<th>Date</th>' +
        '</tr>' +
        '</thead>' +

        '<tbody>' +

        posts
            .slice(0, 5)
            .map(function (post) {

                return (
                    '<tr>' +

                    '<td>' +
                    escapeHtml(post.title) +
                    '</td>' +

                    '<td>' +
                    renderStatus(post.status) +
                    '</td>' +

                    '<td>' +
                    formatDate(
                        post.publication_date ||
                        post.published_at ||
                        post.created_at
                    ) +
                    '</td>' +

                    '</tr>'
                );
            })
            .join('') +

        '</tbody>' +

        '</table>' +

        '</div>';
}


/* =========================================================
   NEWS LIST
   ========================================================= */

function renderNewsList(posts) {

    const element =
        document.getElementById('news-list');


    if (!posts.length) {

        element.innerHTML =
            '<div class="empty-state">' +
            'No insight posts yet. Click "Add insight" to create your first one.' +
            '</div>';

        return;
    }


    element.innerHTML =
        '<div class="table-wrap">' +

        '<table>' +

        '<thead>' +

        '<tr>' +
        '<th>Title</th>' +
        '<th>Category</th>' +
        '<th>Status</th>' +
        '<th>Publication date</th>' +
        '<th>Images</th>' +
        '<th>Actions</th>' +
        '</tr>' +

        '</thead>' +

        '<tbody>' +

        posts
            .map(function (post) {

                const imageCount =
                    Array.isArray(post.image_urls)
                        ? post.image_urls.length
                        : 0;


                return (
                    '<tr>' +

                    '<td>' +

                    '<strong>' +
                    escapeHtml(post.title) +
                    '</strong>' +

                    (
                        post.excerpt
                            ? '<br><small>' +
                              escapeHtml(
                                  post.excerpt.substring(
                                      0,
                                      100
                                  )
                              ) +
                              (
                                  post.excerpt.length > 100
                                      ? '...'
                                      : ''
                              ) +
                              '</small>'
                            : ''
                    ) +

                    '</td>' +

                    '<td>' +
                    escapeHtml(
                        post.category || '-'
                    ) +
                    '</td>' +

                    '<td>' +
                    renderStatus(post.status) +
                    '</td>' +

                    '<td>' +
                    formatDate(
                        post.publication_date ||
                        post.published_at ||
                        post.created_at
                    ) +
                    '</td>' +

                    '<td>' +
                    imageCount +
                    '</td>' +

                    '<td>' +

                    '<div class="table-actions">' +

                    '<button ' +
                    'type="button" ' +
                    'class="btn small" ' +
                    'data-edit-post="' +
                    escapeHtml(post.id) +
                    '">' +
                    'Edit' +
                    '</button>' +

                    '<button ' +
                    'type="button" ' +
                    'class="btn small danger" ' +
                    'data-delete-post="' +
                    escapeHtml(post.id) +
                    '">' +
                    'Delete' +
                    '</button>' +

                    '</div>' +

                    '</td>' +

                    '</tr>'
                );
            })
            .join('') +

        '</tbody>' +

        '</table>' +

        '</div>';


    document
        .querySelectorAll('[data-edit-post]')
        .forEach(function (button) {

            button.addEventListener(
                'click',
                function () {

                    openEditPost(
                        button.dataset.editPost,
                        posts
                    );
                }
            );
        });


    document
        .querySelectorAll('[data-delete-post]')
        .forEach(function (button) {

            button.addEventListener(
                'click',
                function () {

                    deletePost(
                        button.dataset.deletePost
                    );
                }
            );
        });
}


/* =========================================================
   STATUS
   ========================================================= */

function renderStatus(status) {

    return (
        '<span class="status-pill status-' +
        escapeHtml(status) +
        '">' +
        escapeHtml(status) +
        '</span>'
    );
}


/* =========================================================
   EDIT INSIGHT
   ========================================================= */

function openEditPost(id, posts) {

    const post =
        posts.find(function (item) {
            return item.id === id;
        });


    if (!post) {
        return;
    }


    document.getElementById('post-modal-title')
        .textContent = 'Edit insight';


    document.getElementById('post-id')
        .value = post.id;


    document.getElementById('post-title')
        .value = post.title || '';


    document.getElementById('post-excerpt')
        .value = post.excerpt || '';


    document.getElementById('post-body')
    .innerHTML = post.body || '';


    document.getElementById('post-category')
        .value = post.category || '';


    document.getElementById('post-status')
        .value = post.status || 'draft';


    document.getElementById('post-date')
        .value =
        post.publication_date ||
        (
            post.published_at
                ? post.published_at.substring(0, 10)
                : todayAsInputValue()
        );


    document.getElementById('post-author')
        .value =
        window.dashboardUser.profile.full_name ||
        window.dashboardUser.session.user.email;


    window.currentPostImages =
        Array.isArray(post.image_urls)
            ? post.image_urls.slice()
            : [];


    window.selectedImageFiles = [];


    renderImagePreview(
        window.currentPostImages
    );


    const modal =
        document.getElementById('post-modal');


    modal.classList.add('open');


    modal.setAttribute(
        'aria-hidden',
        'false'
    );


    document.getElementById('post-title')
        .focus();
}


/* =========================================================
   DELETE INSIGHT
   ========================================================= */

async function deletePost(id) {

    const confirmed =
        window.confirm(
            'Are you sure you want to delete this insight? This cannot be undone.'
        );


    if (!confirmed) {
        return;
    }


    try {

        const result =
            await client
                .from('insights_posts')
                .delete()
                .eq('id', id);


        if (result.error) {
            throw result.error;
        }


        await loadDashboard(
            window.dashboardUser
        );


    } catch (error) {

        console.error(
            'Error deleting insight:',
            error
        );


        alert(
            error.message ||
            'Unable to delete insight.'
        );
    }
}


/* =========================================================
   ENQUIRIES
   ========================================================= */

function renderEnquiries(enquiries) {

    const element =
        document.getElementById('enquiries-list');


    if (!enquiries.length) {

        element.innerHTML =
            '<div class="empty-state">' +
            'No enquiries yet.' +
            '</div>';

        return;
    }


    element.innerHTML =
        '<div class="table-wrap">' +

        '<table>' +

        '<thead>' +
        '<tr>' +
        '<th>Name</th>' +
        '<th>Organisation</th>' +
        '<th>Email</th>' +
        '<th>Status</th>' +
        '<th>Received</th>' +
        '</tr>' +
        '</thead>' +

        '<tbody>' +

        enquiries
            .map(function (enquiry) {

                return (
                    '<tr>' +

                    '<td>' +
                    escapeHtml(
                        enquiry.full_name
                    ) +
                    '</td>' +

                    '<td>' +
                    escapeHtml(
                        enquiry.organisation || '-'
                    ) +
                    '</td>' +

                    '<td>' +
                    escapeHtml(
                        enquiry.email
                    ) +
                    '</td>' +

                    '<td>' +
                    renderStatus(
                        enquiry.status
                    ) +
                    '</td>' +

                    '<td>' +
                    formatDate(
                        enquiry.created_at
                    ) +
                    '</td>' +

                    '</tr>'
                );
            })
            .join('') +

        '</tbody>' +

        '</table>' +

        '</div>';
}


/* =========================================================
   TEAM
   ========================================================= */

function renderTeam(team) {

    const element =
        document.getElementById('team-list');


    if (!team.length) {

        element.innerHTML =
            '<div class="empty-state">' +
            'No team members yet.' +
            '</div>';

        return;
    }


    element.innerHTML =
        '<div class="table-wrap">' +

        '<table>' +

        '<thead>' +
        '<tr>' +
        '<th>Name</th>' +
        '<th>Role</th>' +
        '<th>Category</th>' +
        '</tr>' +
        '</thead>' +

        '<tbody>' +

        team
            .map(function (member) {

                return (
                    '<tr>' +

                    '<td>' +
                    escapeHtml(member.name) +
                    '</td>' +

                    '<td>' +
                    escapeHtml(
                        member.role_title || '-'
                    ) +
                    '</td>' +

                    '<td>' +
                    escapeHtml(
                        member.category
                    ) +
                    '</td>' +

                    '</tr>'
                );
            })
            .join('') +

        '</tbody>' +

        '</table>' +

        '</div>';
}


/* =========================================================
   CONTENT BLOCKS
   ========================================================= */

function renderContent(content) {

    const element =
        document.getElementById('content-list');


    if (!content.length) {

        element.innerHTML =
            '<div class="empty-state">' +
            'No content blocks yet.' +
            '</div>';

        return;
    }


    element.innerHTML =
        '<div class="table-wrap">' +

        '<table>' +

        '<thead>' +
        '<tr>' +
        '<th>Key</th>' +
        '<th>Value</th>' +
        '<th>Updated</th>' +
        '</tr>' +
        '</thead>' +

        '<tbody>' +

        content
            .map(function (block) {

                return (
                    '<tr>' +

                    '<td>' +
                    '<strong>' +
                    escapeHtml(block.key) +
                    '</strong>' +
                    '</td>' +

                    '<td>' +
                    escapeHtml(
                        block.value || '-'
                    ) +
                    '</td>' +

                    '<td>' +
                    formatDate(
                        block.updated_at
                    ) +
                    '</td>' +

                    '</tr>'
                );
            })
            .join('') +

        '</tbody>' +

        '</table>' +

        '</div>';
}


/* =========================================================
   MODAL
   ========================================================= */

function closePostModal() {

    const modal =
        document.getElementById('post-modal');


    modal.classList.remove('open');


    modal.setAttribute(
        'aria-hidden',
        'true'
    );


    document.getElementById('post-form')
        .reset();
document.getElementById('post-body')
    .innerHTML = '';

    document.getElementById('post-id')
        .value = '';


    document.getElementById('post-modal-title')
        .textContent = 'Add insight';


    document.getElementById('post-error')
        .textContent = '';


    window.currentPostImages = [];

    window.selectedImageFiles = [];


    renderImagePreview([]);
}


function openPostModal() {

    closePostModal();


    document.getElementById('post-author')
        .value =
        window.dashboardUser.profile.full_name ||
        window.dashboardUser.session.user.email;


    document.getElementById('post-date')
        .value =
        todayAsInputValue();


    document.getElementById('post-status')
        .value = 'draft';


    const modal =
        document.getElementById('post-modal');


    modal.classList.add('open');


    modal.setAttribute(
        'aria-hidden',
        'false'
    );


    document.getElementById('post-title')
        .focus();
}


/* =========================================================
   NAVIGATION EVENTS
   ========================================================= */

document
    .querySelectorAll('[data-panel]')
    .forEach(function (button) {

        button.addEventListener(
            'click',
            function () {

                showPanel(
                    button.dataset.panel
                );
            }
        );
    });


document
    .querySelectorAll('[data-go]')
    .forEach(function (button) {

        button.addEventListener(
            'click',
            function () {

                showPanel(
                    button.dataset.go
                );
            }
        );
    });


document
    .getElementById('logout-button')
    .addEventListener(
        'click',
        signOut
    );


document
    .getElementById('open-post-modal')
    .addEventListener(
        'click',
        openPostModal
    );


document
    .getElementById('close-post-modal')
    .addEventListener(
        'click',
        closePostModal
    );


document
    .getElementById('close-post-modal-x')
    .addEventListener(
        'click',
        closePostModal
    );


document
    .getElementById('post-modal')
    .addEventListener(
        'click',
        function (event) {

            if (
                event.target.id ===
                'post-modal'
            ) {
                closePostModal();
            }
        }
    );


document.addEventListener(
    'keydown',
    function (event) {

        if (event.key === 'Escape') {
            closePostModal();
        }
    }
);


/* =========================================================
   IMAGE SELECTION
   ========================================================= */

document
    .getElementById('post-images')
    .addEventListener(
        'change',
        function (event) {

            const files =
                Array.from(
                    event.target.files || []
                );


            if (!files.length) {

                window.selectedImageFiles = [];

                renderImagePreview(
                    window.currentPostImages || []
                );

                return;
            }


            window.selectedImageFiles =
                files;


            const previewUrls =
                files.map(function (file) {
                    return URL.createObjectURL(file);
                });


            renderImagePreview(
                previewUrls
            );
        }
    );

/* =========================================================
   RICH TEXT EDITOR
   ========================================================= */

document
    .querySelectorAll('#editor-toolbar [data-command]')
    .forEach(function (button) {
        button.addEventListener(
            'click',
            function () {
                const command =
                    button.dataset.command;

                const value =
                    button.dataset.value || null;

                const editor =
                    document.getElementById('post-body');

                editor.focus();

                if (command === 'createLink') {
                    const url =
                        window.prompt(
                            'Enter the URL:',
                            'https://'
                        );

                    if (url) {
                        document.execCommand(
                            'createLink',
                            false,
                            url
                        );
                    }

                    return;
                }

                document.execCommand(
                    command,
                    false,
                    value
                );
            }
        );
    });
/* =========================================================
   SAVE INSIGHT
   ========================================================= */

document
    .getElementById('post-form')
    .addEventListener(
        'submit',
        async function (event) {

            event.preventDefault();


            const errorElement =
                document.getElementById(
                    'post-error'
                );


            const submitButton =
                document.getElementById(
                    'save-post-button'
                );


            errorElement.textContent = '';


            submitButton.disabled = true;


            submitButton.textContent =
                'Saving...';


            try {

                const postId =
                    document.getElementById(
                        'post-id'
                    ).value;


                const title =
                    document.getElementById(
                        'post-title'
                    ).value.trim();


                const excerpt =
                    document.getElementById(
                        'post-excerpt'
                    ).value.trim();


                const body =
    document.getElementById(
        'post-body'
    ).innerHTML.trim();


                const category =
                    document.getElementById(
                        'post-category'
                    ).value;


                const status =
                    document.getElementById(
                        'post-status'
                    ).value;


                const publicationDate =
                    document.getElementById(
                        'post-date'
                    ).value;


                if (!title) {
                    throw new Error(
                        'Please enter a title.'
                    );
                }


                if (!excerpt) {
                    throw new Error(
                        'Please enter an excerpt.'
                    );
                }


                if (!publicationDate) {
                    throw new Error(
                        'Please select a publication date.'
                    );
                }


                let imageUrls =
                    window.currentPostImages
                        ? window.currentPostImages.slice()
                        : [];


                const selectedFiles =
                    window.selectedImageFiles || [];


                if (selectedFiles.length) {

                    submitButton.textContent =
                        'Uploading images...';


                    const newUrls =
                        await uploadImages(
                            selectedFiles
                        );


                    imageUrls =
                        imageUrls.concat(
                            newUrls
                        );
                }


                const postData = {

                    title: title,

                    excerpt: excerpt,

                    body: body || null,

                    category:
                        category || null,

                    status: status,

                    publication_date:
                        publicationDate,

                    author_id:
                        window.dashboardUser
                            .session
                            .user
                            .id,

                    image_urls:
                        imageUrls,

                    featured_image_url:
                        imageUrls.length
                            ? imageUrls[0]
                            : null
                };


                if (status === 'published') {

                    postData.published_at =
                        new Date(
                            publicationDate +
                            'T12:00:00'
                        ).toISOString();

                } else {

                    postData.published_at =
                        null;
                }


                let result;


                if (postId) {

                    result =
                        await client
                            .from('insights_posts')
                            .update(postData)
                            .eq('id', postId);

                } else {

                    postData.slug =
                        createSlug(title);


                    result =
                        await client
                            .from('insights_posts')
                            .insert(postData);
                }


                if (result.error) {
                    throw result.error;
                }


                closePostModal();


                window.selectedImageFiles = [];

                window.currentPostImages = [];


                await loadDashboard(
                    window.dashboardUser
                );


            } catch (error) {

                console.error(
                    'Error saving insight:',
                    error
                );


                errorElement.textContent =
                    error.message ||
                    'Unable to save insight.';

            } finally {

                submitButton.disabled =
                    false;

                submitButton.textContent =
                    'Save insight';
            }
        }
    );


/* =========================================================
   START DASHBOARD
   ========================================================= */

(async function () {

    try {

        console.log(
            'Starting dashboard authentication...'
        );


        window.dashboardUser =
            await requireAuth();


        console.log(
            'Authenticated user:',
            window.dashboardUser
        );


        if (window.dashboardUser) {

            console.log(
                'Loading dashboard data...'
            );


            await loadDashboard(
                window.dashboardUser
            );


            console.log(
                'Dashboard loaded successfully.'
            );
        }


    } catch (error) {

        console.error(
            'Dashboard error:',
            error
        );


        const mainContent =
            document.querySelector(
                '.main-content'
            );


        if (mainContent) {

            mainContent.innerHTML =
                '<div style="padding: 40px;">' +

                '<h2>' +
                'Unable to load the dashboard' +
                '</h2>' +

                '<p class="form-error">' +
                escapeHtml(
                    error.message ||
                    'An unknown error occurred.'
                ) +
                '</p>' +

                '<p>' +
                'Please check the browser console for more details.' +
                '</p>' +

                '</div>';
        }

    }

})();
