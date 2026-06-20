(function () {
  // 提交反馈：POST 到当前页面的 /submit（同源，admin 反代回 agent server）
  function submit(data) {
    fetch(window.location.pathname.replace(/\/$/, '') + '/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(() => {
      const el = document.getElementById('crabot-status')
      if (el) el.textContent = '已提交，可关闭本页'
    }).catch(() => {})
  }

  // 约定：页面里给可点选元素加 data-choice，点击即提交
  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-choice]')
    if (!t) return
    submit({ type: 'click', choice: t.dataset.choice, text: (t.textContent || '').trim() })
  })

  // 暴露给页面显式调用：crabotSubmit({...}) 提交任意结构（如表单）
  window.crabotSubmit = submit
})()
