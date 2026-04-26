(function () {
  'use strict';

  var C = CopilotDashboard;

  var PAGE_SIZE = 15;
  var MAX_VISIBLE_PAGES = 5;

  var members = [];
  var filteredMembers = [];
  var currentPage = 1;
  var currentSort = { key: 'login', dir: 'asc' };

  var fileInput = document.getElementById('fileInput');
  var uploadBtn = document.getElementById('uploadBtn');
  var uploadStatus = document.getElementById('uploadStatus');
  var reloadMappingBtn = document.getElementById('reloadMappingBtn');
  var reloadMembersBtn = document.getElementById('reloadMembersBtn');
  var mappingMeta = document.getElementById('mappingMeta');
  var errorBox = document.getElementById('error');
  var membersTable = document.getElementById('membersTable');
  var membersTbody = document.getElementById('membersTbody');
  var pagination = document.getElementById('pagination');

  function escapeHtml(str) { return C.escapeHtml(str); }
  function formatTs(isoText) { return isoText ? C.formatTs(isoText) : '未知'; }
  function setError(message) { C.setError(errorBox, message); }

  function sortData(data, key, dir) {
    var arr = data.slice();
    arr.sort(function (a, b) {
      var av = a[key] || '';
      var bv = b[key] || '';
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }

  function updateSortHeaders() {
    var headers = membersTable.querySelectorAll('thead th[data-sort]');
    headers.forEach(function (th) {
      var key = th.getAttribute('data-sort');
      var arrow = th.querySelector('.sort-arrow');
      if (!arrow) return;
      th.classList.remove('sorted');
      if (currentSort.key === key) {
        th.classList.add('sorted');
        arrow.textContent = currentSort.dir === 'asc' ? '▲' : '▼';
      } else {
        arrow.textContent = '';
      }
    });
  }

  function renderSkeleton(rows) {
    var html = '';
    for (var i = 0; i < rows; i++) {
      html += '<tr class="skeleton-row">';
      html += '<td><span class="skeleton-line" style="width: 70%"></span></td>';
      html += '<td><span class="skeleton-line" style="width: 80%"></span></td>';
      html += '<td><span class="skeleton-line" style="width: 60%"></span></td>';
      html += '<td><span class="skeleton-line" style="width: 80%"></span></td>';
      html += '<td><span class="skeleton-line" style="width: 50%"></span></td>';
      html += '<td><span class="skeleton-line" style="width: 65%"></span></td>';
      html += '<td><span class="skeleton-line" style="width: 40%"></span></td>';
      html += '</tr>';
    }
    membersTbody.innerHTML = html;
  }

  function renderPagination() {
    var total = filteredMembers.length;
    var totalPages = Math.ceil(total / PAGE_SIZE);

    if (totalPages <= 1) {
      pagination.classList.add('hidden');
      return;
    }
    pagination.classList.remove('hidden');

    var html = '';

    if (currentPage > 1) {
      html +=
        '<button class="page-btn" data-page="' +
        (currentPage - 1) +
        '">上一页</button>';
    }

    var startPage, endPage;
    if (totalPages <= MAX_VISIBLE_PAGES) {
      startPage = 1;
      endPage = totalPages;
    } else {
      var half = Math.floor(MAX_VISIBLE_PAGES / 2);
      if (currentPage <= half + 1) {
        startPage = 1;
        endPage = MAX_VISIBLE_PAGES;
      } else if (currentPage >= totalPages - half) {
        startPage = totalPages - MAX_VISIBLE_PAGES + 1;
        endPage = totalPages;
      } else {
        startPage = currentPage - half;
        endPage = currentPage + half;
      }
    }

    if (startPage > 1) {
      html += '<button class="page-btn" data-page="1">1</button>';
      if (startPage > 2) {
        html += '<span class="page-ellipsis">...</span>';
      }
    }

    for (var i = startPage; i <= endPage; i++) {
      var activeClass = i === currentPage ? ' active' : '';
      html +=
        '<button class="page-btn' +
        activeClass +
        '" data-page="' +
        i +
        '">' +
        i +
        '</button>';
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        html += '<span class="page-ellipsis">...</span>';
      }
      html +=
        '<button class="page-btn" data-page="' +
        totalPages +
        '">' +
        totalPages +
        '</button>';
    }

    if (currentPage < totalPages) {
      html +=
        '<button class="page-btn" data-page="' +
        (currentPage + 1) +
        '">下一页</button>';
    }

    pagination.innerHTML = html;

    var buttons = pagination.querySelectorAll('.page-btn');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var page = parseInt(btn.getAttribute('data-page'), 10);
        if (page !== currentPage) {
          currentPage = page;
          renderTable();
        }
      });
    });
  }

  function renderTable() {
    var total = filteredMembers.length;
    var totalPages = Math.ceil(total / PAGE_SIZE);
    if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
    if (totalPages === 0) currentPage = 1;

    var start = (currentPage - 1) * PAGE_SIZE;
    var end = start + PAGE_SIZE;
    var pageData = filteredMembers.slice(start, end);

    if (pageData.length === 0) {
      membersTbody.innerHTML =
        '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
    } else {
      var html = '';
      pageData.forEach(function (m) {
        var adName = m.adName || '--';
        var adMail = m.adMail || '--';
        var team = m.team || '--';
        var isMapped = !!(m.adName && m.adName !== '--');
        var badgeClass = isMapped ? 'badge-mapped' : 'badge-unmapped';
        var badgeText = isMapped ? '已映射' : '未映射';
        var adNameClass = isMapped ? 'ad-name-highlight' : '';

        html += '<tr>';
        html += '<td>' + escapeHtml(m.login) + '</td>';
        html += '<td>' + escapeHtml(team) + '</td>';
        html += '<td class="' + adNameClass + '">' + escapeHtml(adName) + '</td>';
        html += '<td>' + escapeHtml(adMail) + '</td>';
        html += '<td>' + escapeHtml(m.planType || '--') + '</td>';
        html += '<td>' + escapeHtml(formatTs(m.lastActivityAt)) + '</td>';
        html += '<td><span class="' + badgeClass + '">' + badgeText + '</span></td>';
        html += '</tr>';
      });
      membersTbody.innerHTML = html;
    }

    renderPagination();
    updateSortHeaders();
  }

  uploadBtn.addEventListener('click', function () {
    fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    if (!file) return;

    setError(null);
    uploadStatus.textContent = '上传中...';
    uploadStatus.classList.remove('status-error');

    var formData = new FormData();
    formData.append('file', file);

    fetch('/user/upload-members', {
      method: 'POST',
      body: formData,
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (result) {
        if (!result.res.ok) {
          throw new Error(
            result.data && result.data.error
              ? result.data.error
              : '上传失败 (' + result.res.status + ')'
          );
        }
        uploadStatus.textContent =
          '上传成功: ' + (result.data.message || result.data.fileName || file.name);
        uploadStatus.classList.remove('status-error');
        fileInput.value = '';
      })
      .catch(function (err) {
        uploadStatus.textContent = '上传失败: ' + err.message;
        uploadStatus.classList.add('status-error');
        setError(err.message);
        fileInput.value = '';
      });
  });

  reloadMappingBtn.addEventListener('click', function () {
    setError(null);
    reloadMappingBtn.disabled = true;
    mappingMeta.textContent = '正在加载映射数据...';
    mappingMeta.classList.add('refreshing');

    fetch('/user/reload-mapping', { method: 'POST' })
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (result) {
        reloadMappingBtn.disabled = false;
        mappingMeta.classList.remove('refreshing');
        if (!result.res.ok) {
          throw new Error(
            result.data && result.data.error
              ? result.data.error
              : '加载失败 (' + result.res.status + ')'
          );
        }
        var count = result.data.count || 0;
        var msg = result.data.message || '映射数据已加载';
        mappingMeta.textContent = msg + ' (共 ' + count + ' 条映射)';
      })
      .catch(function (err) {
        reloadMappingBtn.disabled = false;
        mappingMeta.classList.remove('refreshing');
        mappingMeta.textContent = '加载映射数据失败';
        setError(err.message);
      });
  });

  reloadMembersBtn.addEventListener('click', function () {
    setError(null);
    reloadMembersBtn.disabled = true;
    renderSkeleton(8);

    fetch('/api/user/members')
      .then(function (res) {
        return res.json().then(function (data) {
          return { res: res, data: data };
        });
      })
      .then(function (result) {
        reloadMembersBtn.disabled = false;
        if (!result.res.ok) {
          throw new Error(
            result.data && result.data.error
              ? result.data.error
              : '加载失败 (' + result.res.status + ')'
          );
        }
        members = result.data.members || [];
        filteredMembers = sortData(members, currentSort.key, currentSort.dir);
        currentPage = 1;
        renderTable();

        var metaText = '成员数: ' + members.length;
        if (result.data.loadedAt) {
          metaText += ' · 加载时间: ' + formatTs(result.data.loadedAt);
        }
        mappingMeta.textContent = metaText;
      })
      .catch(function (err) {
        reloadMembersBtn.disabled = false;
        membersTbody.innerHTML =
          '<tr><td colspan="6" class="empty">加载失败: ' +
          escapeHtml(err.message) +
          '</td></tr>';
        setError(err.message);
      });
  });

  var headers = membersTable.querySelectorAll('thead th[data-sort]');
  headers.forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (currentSort.key === key) {
        currentSort.dir = currentSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.key = key;
        currentSort.dir = 'asc';
      }
      filteredMembers = sortData(filteredMembers, currentSort.key, currentSort.dir);
      currentPage = 1;
      renderTable();
    });
  });
})();
