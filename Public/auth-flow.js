(function(){
  const $ = id => document.getElementById(id);

  const usernameInput = $("username");
  const passwordInput = $("password");
  const authMsg = $("authMsg");
  const realRegisterBtn = $("registerBtn"); // bound by app.js, kept hidden

  const steps = {
    login: $("stepLogin"),
    user:  $("stepUser"),
    pass:  $("stepPass"),
    done:  $("stepDone")
  };

  function showStep(name){
    Object.values(steps).forEach(s => s.classList.add("hidden"));
    steps[name].classList.remove("hidden");
  }

  function clearErrors(){
    $("userErr").textContent = "";
    $("passErr").textContent = "";
  }

  function resetSubmitBtn(){
    $("submitRegister").disabled = false;
    $("submitRegister").textContent = "Create account";
  }

  function backToLogin(){
    $("fieldsHostLogin").appendChild(usernameInput);
    $("fieldsHostLogin").appendChild(passwordInput);
    usernameInput.classList.remove("hidden");
    passwordInput.classList.remove("hidden");
    resetSubmitBtn();
    clearErrors();
    showStep("login");
  }

  // initial placement: fields live in the login step by default
  backToLogin();
  authMsg.textContent = "";

  $("openRegister").addEventListener("click", () => {
    clearErrors();
    authMsg.textContent = "";
    usernameInput.value = "";
    passwordInput.value = "";
    $("fieldsHostUser").appendChild(usernameInput);
    usernameInput.classList.remove("hidden");
    showStep("user");
    usernameInput.focus();
  });

  $("cancelToLogin1").addEventListener("click", backToLogin);

  $("backToUserStep").addEventListener("click", () => {
    $("fieldsHostUser").appendChild(usernameInput);
    showStep("user");
  });

  $("toPasswordStep").addEventListener("click", () => {
    const v = usernameInput.value.trim();
    if (v.length < 3){
      $("userErr").textContent = "Username must be at least 3 characters";
      return;
    }
    $("userErr").textContent = "";
    passwordInput.value = "";
    $("fieldsHostPass").appendChild(passwordInput);
    passwordInput.classList.remove("hidden");
    showStep("pass");
    passwordInput.focus();
  });

  $("submitRegister").addEventListener("click", () => {
    const v = passwordInput.value;
    if (v.length < 4){
      $("passErr").textContent = "Password must be at least 4 characters";
      return;
    }
    $("passErr").textContent = "";
    $("submitRegister").disabled = true;
    $("submitRegister").textContent = "Creating…";
    authMsg.textContent = "";

    // safety net: if the server never responds, don't leave the button stuck forever
    clearTimeout(window.__regTimeout);
    window.__regTimeout = setTimeout(() => {
      $("passErr").textContent = "Server is taking too long to respond. Check your connection and try again.";
      resetSubmitBtn();
    }, 10000);

    realRegisterBtn.click(); // triggers app.js's real /api/register call
  });

  // app.js writes the result into #authMsg (green = success, red = error).
  // We watch it to drive the wizard forward or show the error inline.
  const obs = new MutationObserver(() => {
    if (steps.pass.classList.contains("hidden")) return; // ignore login-page messages
    const text = authMsg.textContent;
    if (!text) return;
    clearTimeout(window.__regTimeout);
    const success = authMsg.style.color === "green";
    if (success){
      showStep("done");
      setTimeout(backToLogin, 1400);
    } else {
      $("passErr").textContent = text;
      resetSubmitBtn();
    }
  });
  obs.observe(authMsg, { childList: true, characterData: true, subtree: true });
})();
